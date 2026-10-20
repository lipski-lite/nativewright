'use strict';

/**
 * The long-running browser daemon. Owns a single Patchright
 * `BrowserContext`, keeps a registry of pages keyed by STABLE ids, gives
 * every page its own queue and its own window, and exposes a tiny
 * JSON-over-HTTP command surface on `127.0.0.1:<ephemeral port>`.
 *
 * Concurrency model — safe for any number of clients at once:
 *
 *   • There is NO shared "active page". A page-targeting request names its
 *     page (`--page=<id>`) and the daemon binds the command to that page
 *     inside that page's own serialized queue. Nothing two clients touch is
 *     shared mutable state, so they cannot clobber each other.
 *   • Page ids are stable for the page's lifetime (p1, p2, …) and are never
 *     re-indexed when another page closes.
 *   • Frame scope, dialog policy and console/network/download buffers are
 *     all per page.
 *   • Commands on different pages run concurrently; commands on the same
 *     page are serialized. Pageless commands use a meta queue.
 *   • Each `new` page opens in its OWN WINDOW (Target.createTarget with
 *     newWindow). A page in its own window stays a foreground page
 *     (visibilityState 'visible', timers and rAF running) even when other
 *     windows overlap it; background TABS in a shared window are hidden and
 *     throttled, which breaks animations, observers, lazy-loading and
 *     screenshots.
 *   • Lifecycle is lease-based: clients `close` their page when done. The
 *     daemon idle-exits gracefully (flushing the profile) after the last
 *     page has been closed for IDLE_EXIT_MS. `stop` refuses while pages are
 *     live unless forced. A minimized internal keeper window keeps Chromium
 *     alive between leases (Chromium exits when its last window closes).
 *
 * One daemon serves one profile (identity). Distinct identities need
 * distinct profiles → distinct daemons via separate `NATIVEWRIGHT_HOME`
 * roots (the lockfile lives under the root).
 *
 * @module daemon
 */

const http = require('http');
const { chromium } = require('patchright');

const cfg = require('./config');
const human = require('./human');
const timing = require('./timing');
const wheel = require('./wheel');
const { commands, PAGELESS } = require('./commands');

// A touch-only (tablet-class) device reports 10 simultaneous contacts; `hasTouch`
// alone reports 1, which would contradict a two-finger pinch.
const TOUCH_MAX_POINTS = 10;

// In-page hook that survives Patchright's suppression of `Runtime.enable` /
// `Console.enable`. Re-injected after every navigation.
const CONSOLE_INIT_SOURCE = `
  (() => {
    if (window.__nativewright_console__) return 'already';
    const buf = [];
    const push = (type, args) => {
      let text;
      try {
        text = Array.from(args).map((a) => {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
          return String(a);
        }).join(' ');
      } catch (e) { text = '[unserializable]'; }
      buf.push({ at: new Date().toISOString(), type, text });
      if (buf.length > 500) buf.shift();
    };
    window.__nativewright_console__ = buf;
    for (const t of ['log','warn','error','info','debug']) {
      const orig = console[t].bind(console);
      console[t] = function () { push(t, arguments); return orig.apply(console, arguments); };
    }
    window.addEventListener('error', (e) => push('pageerror', [e.message || (e.error && e.error.message) || String(e)]));
    window.addEventListener('unhandledrejection', (e) => push('unhandledrejection', [e.reason && (e.reason.stack || e.reason.message) || String(e.reason)]));
    return 'installed';
  })();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Truthy env flag under either accepted prefix. */
function envFlag(suffix) {
  return /^(1|true|yes|on)$/i.test(cfg.envAny(suffix));
}

/** Serialize async work: each queue runs its jobs strictly one at a time. */
function makeQueue() {
  let chain = Promise.resolve();
  return function enqueue(fn) {
    const next = chain.then(() => fn(), () => fn());
    chain = next.catch(() => {});
    return next;
  };
}

// ---------- session state ---------------------------------------------------

function createSession() {
  const pages = new Map();              // id -> rec
  let nextId = 1;
  let windowSlot = 0;
  let _context = null;
  let _browserCdp = null;
  let _consoleInit = null;
  let _keeper = null;
  let _shutdown = null;
  let _headless = false;
  let _touch = false;
  let idleTimer = null;
  const commandLog = [];
  const startedAt = new Date().toISOString();
  const metaQueue = makeQueue();

  async function ensureConsoleHook(page) {
    if (!_consoleInit) return;
    try { await page.evaluate(_consoleInit); } catch { /* page may not be ready */ }
  }

  function findRec(page) {
    for (const r of pages.values()) if (r.page === page) return r;
    return null;
  }

  function adoptPage(page, meta = {}) {
    const existing = findRec(page);
    if (existing) return existing;
    const id = 'p' + (nextId++);
    const rec = {
      id, page,
      label: meta.label || null,
      opener: meta.opener || null,
      cwd: meta.cwd || null,
      createdAt: new Date().toISOString(),
      windowId: null,
      console: [], network: [], downloads: [],
      frameRef: null,
      dialogPolicy: { action: 'dismiss', promptText: undefined },
      queue: makeQueue(),
    };
    pages.set(id, rec);
    wirePage(rec);
    ensureConsoleHook(page).catch(() => {});
    cfg.appendLog(`[${id}] page adopted` +
      (rec.label ? ` label=${rec.label}` : '') +
      (rec.opener ? ` opener=${rec.opener}` : ''));
    onPagesChanged();
    return rec;
  }

  function wirePage(rec) {
    const { page } = rec;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) ensureConsoleHook(page).catch(() => {});
    });
    page.on('dialog', async (dialog) => {
      try {
        if (rec.dialogPolicy.action === 'accept') await dialog.accept(rec.dialogPolicy.promptText || undefined);
        else await dialog.dismiss();
      } catch (e) { cfg.appendLog(`[${rec.id}] dialog handler error: ${e.message}`); }
    });
    page.on('download', async (dl) => {
      const entry = {
        at: new Date().toISOString(),
        url: dl.url(),
        suggested: dl.suggestedFilename(),
        path: null,
        error: null,
      };
      rec.downloads.push(entry);
      while (rec.downloads.length > 50) rec.downloads.shift();
      try {
        const path = require('path');
        const dir = cfg.artifactsDir(rec.cwd);
        cfg.ensureDir(dir);
        const safe = (dl.suggestedFilename() || 'download').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const target = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}`);
        await dl.saveAs(target);
        entry.path = target;
        cfg.appendLog(`[${rec.id}] download saved ${target}`);
      } catch (e) {
        entry.error = e.message;
        cfg.appendLog(`[${rec.id}] download failed: ${e.message}`);
      }
    });
    page.on('request', (req) => {
      rec.network.push({
        at: new Date().toISOString(), dir: 'req',
        method: req.method(), url: req.url(), resourceType: req.resourceType(),
      });
      while (rec.network.length > 100) rec.network.shift();
    });
    page.on('response', (res) => {
      rec.network.push({
        at: new Date().toISOString(), dir: 'res',
        status: res.status(), url: res.url(),
      });
      while (rec.network.length > 100) rec.network.shift();
    });
    page.on('close', () => {
      if (pages.get(rec.id) === rec) pages.delete(rec.id);
      cfg.appendLog(`[${rec.id}] page closed (${pages.size} remaining)`);
      onPagesChanged();
    });
  }

  // ---- window helpers via a short-lived CDP session on the page ----------

  async function withPageCdp(page, fn) {
    const s = await _context.newCDPSession(page);
    try { return await fn(s); }
    finally { await s.detach().catch(() => {}); }
  }

  async function setWindowBounds(page, bounds) {
    return withPageCdp(page, async (s) => {
      const { windowId } = await s.send('Browser.getWindowForTarget');
      await s.send('Browser.setWindowBounds', { windowId, bounds });
      return windowId;
    });
  }

  async function windowIdOf(page) {
    try {
      return await withPageCdp(page, async (s) => (await s.send('Browser.getWindowForTarget')).windowId);
    } catch { return null; }
  }

  /**
   * Open a page in its own window (falls back to a tab if the browser-level
   * CDP session is unavailable). Cascades windows so a person sees them apart.
   */
  async function newPage(opts = {}) {
    if (!_context) throw new Error('context not ready');
    const before = new Set(_context.pages());
    let page = null;
    if (opts.window !== false && _browserCdp) {
      try {
        await _browserCdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
        for (let i = 0; i < 80 && !page; i++) {
          await sleep(50);
          page = _context.pages().find((p) => !before.has(p)) || null;
        }
        if (!page) cfg.appendLog('createTarget(newWindow) produced no page in time; falling back to a tab');
      } catch (e) {
        cfg.appendLog(`createTarget(newWindow) failed, falling back to a tab: ${e.message}`);
        page = null;
      }
    }
    if (!page) page = await _context.newPage();
    const rec = adoptPage(page, { label: opts.label, cwd: opts.cwd });
    if (opts.label != null && !rec.label) rec.label = opts.label;
    if (opts.cwd && !rec.cwd) rec.cwd = opts.cwd;
    await applyTouch(page);       // before the caller can navigate: no page ever sees the intermediate maxTouchPoints
    try {
      const k = (windowSlot++) % 8;
      rec.windowId = await setWindowBounds(page, {
        left: 40 + k * 56, top: 40 + k * 44, width: 1180, height: 820, windowState: 'normal',
      });
    } catch {
      rec.windowId = await windowIdOf(page);
    }
    return rec;
  }

  /**
   * Resolve the page a request targets. An explicit --page wins; a lone page
   * is unambiguous; anything else is refused rather than guessed — a guess is
   * exactly how one client would end up driving another client's page.
   */
  function resolve(args) {
    const ids = [...pages.keys()];
    if (args && args.page != null && args.page !== '') {
      const rec = pages.get(String(args.page));
      if (!rec) throw new Error(`no page '${args.page}' (open pages: ${ids.length ? ids.join(', ') : 'none'})`);
      return rec;
    }
    if (pages.size === 1) return pages.values().next().value;
    if (pages.size === 0) throw new Error('no pages open — run `new` first (it returns the id to pass as --page=<id>)');
    throw new Error(
      `${pages.size} pages are open (${ids.join(', ')}); pass --page=<id>. ` +
      'Ambiguous targeting is refused so clients never drive each other\'s page.'
    );
  }

  function frameOf(rec) {
    if (!rec.frameRef) return null;
    const { type, value } = rec.frameRef;
    if (type === 'name') return rec.page.frame({ name: value }) || null;
    if (type === 'index') { const frames = rec.page.frames(); return frames[value] || null; }
    return null;
  }

  function listPages() {
    return [...pages.values()].map((r) => ({
      page: r.id,
      label: r.label,
      url: r.page.url(),
      windowId: r.windowId,
      opener: r.opener,
      cwd: r.cwd,
      createdAt: r.createdAt,
      // where the pointer is and what is still held (a forgotten hold must be visible)
      input: human.inputSnapshot(r.page),
    }));
  }

  /**
   * Touch-capable configuration (NATIVEWRIGHT_TOUCH=1): the context is launched
   * with hasTouch, and every page is raised from maxTouchPoints=1 to 10 over its
   * (kept-open) CDP session. The override is per page target and per session, so
   * the session is the page's cached one and is never detached.
   */
  async function applyTouch(page) {
    if (!_touch) return;
    try {
      const cdp = await human.getCdpSession(page);
      if (cdp) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: TOUCH_MAX_POINTS });
    } catch (e) { cfg.appendLog(`touch emulation failed: ${e.message}`); }
  }

  async function closePage(rec) {
    // never leave a button or key logically down behind a closing page (best effort, bounded)
    try {
      await Promise.race([human.releaseAll(rec.page), new Promise((r) => setTimeout(r, 3000))]);
    } catch { /* the page may already be gone */ }
    await rec.page.close();
    return { closed: rec.id, remaining: pages.size };
  }

  function onPagesChanged() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (pages.size === 0 && cfg.IDLE_EXIT_MS > 0 && _shutdown) {
      idleTimer = setTimeout(() => {
        cfg.appendLog(`no pages for ${cfg.IDLE_EXIT_MS}ms — idle exit`);
        _shutdown(0);
      }, cfg.IDLE_EXIT_MS);
    }
  }

  /** The initial launch page keeps Chromium alive between leases. Never listed. */
  async function setupKeeper(page) {
    _keeper = page;
    try { await setWindowBounds(page, { windowState: 'minimized' }); } catch { /* best effort (headless) */ }
  }

  function snapshot() {
    const cal = wheel.calibrationStatus();
    return {
      startedAt,
      pageCount: pages.size,
      pages: listPages(),
      keeper: !!_keeper && !_keeper.isClosed(),
      headless: _headless,
      touch: _touch,
      // the wheel model scrolling uses ('default' | 'human') and what calibration file is on disk
      wheelModel: cal.model,
      wheelCalibration: cal.calibration,
      idleExitMs: cfg.IDLE_EXIT_MS,
      idleTimerArmed: !!idleTimer,
      profile: cfg.PROFILE || 'default',
      userDataDir: cfg.userDataDir(),
      commandLog: commandLog.slice(-20),
    };
  }

  function logCommand(entry) {
    commandLog.push(entry);
    while (commandLog.length > 20) commandLog.shift();
  }

  return {
    context() { return _context; },
    setContext(c) { _context = c; },
    setBrowserCdp(s) { _browserCdp = s; },
    setConsoleInit(src) { _consoleInit = src; },
    setShutdown(fn) { _shutdown = fn; onPagesChanged(); },
    setHeadless(v) { _headless = !!v; },
    setTouch(v) { _touch = !!v; },
    isHeadless: () => _headless,
    touchEnabled: () => _touch,
    applyTouch,
    ensureConsoleHook,
    adoptPage, findRec, newPage, resolve, frameOf, listPages, closePage,
    setupKeeper, metaQueue, snapshot, logCommand,
    pageCount: () => pages.size,
    pageIds: () => [...pages.keys()],
  };
}

// ---------- HTTP helpers ----------------------------------------------------

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Strip ANSI escape sequences (Playwright error messages are decorated with
// them; clients get cleaner JSON without).
function stripAnsi(s) {
  return typeof s === 'string'
    ? s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    : s;
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

// ---------- event clock -----------------------------------------------------

/**
 * Pin the browser's clock offset to the event clock (timing.pinClock) on the daemon's own keeper page. Only a blank page
 * qualifies: if the profile restored a website into the first window, the pin is skipped (the first coalesced pointer
 * burst then freezes Chrome's offset a moment later, which is a sub-millisecond difference). Never throws; never hangs.
 */
async function pinEventClock(page) {
  try {
    const url = page.url();
    if (url !== 'about:blank' && !/^chrome:\/\/(new-?tab|newtab-page|new-tab-page)/.test(url)) {
      cfg.appendLog(`event clock not pinned on the first page (${url.split('/')[0]}//…): it is not the daemon's own blank page`);
      return;
    }
    const cdp = await human.getCdpSession(page);
    if (!cdp) throw new Error('no CDP session on the keeper page');
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after 5000 ms')), 5000); });
    try { await Promise.race([timing.pinClock(cdp), limit]); } finally { clearTimeout(timer); }
    cfg.appendLog('event clock pinned');
  } catch (e) {
    cfg.appendLog(`event clock pin failed (not fatal): ${e.message}`);
  }
}

// ---------- daemon entry ----------------------------------------------------

async function runDaemon({ scriptPath }) {
  cfg.ensureDir(cfg.ROOT_DIR);
  cfg.ensureDir(cfg.LOG_DIR);
  cfg.ensureDir(cfg.userDataDir());

  const existing = await cfg.readLockfile();
  if (existing) {
    const alive = await cfg.verifyLockfile(existing);
    if (alive) {
      process.stderr.write(
        `daemon already running: pid=${existing.pid} port=${existing.port}\n` +
        `use \`node "${scriptPath}" stop\` first.\n`
      );
      process.exit(0);
    }
    cfg.appendLog(`reaping stale lockfile pid=${existing.pid} port=${existing.port}`);
    await cfg.deleteLockfile();
  }

  const session = createSession();
  session.setConsoleInit(CONSOLE_INIT_SOURCE);

  // ---- launch browser ----------------------------------------------------
  cfg.appendLog(`daemon starting; userDataDir=${cfg.userDataDir()} idleExitMs=${cfg.IDLE_EXIT_MS}`);
  const headless = envFlag('HEADLESS');
  const touchMode = envFlag('TOUCH');
  const channel  = cfg.envAny('CHANNEL') || 'chrome';
  session.setHeadless(headless);
  session.setTouch(touchMode);

  /** @type {import('patchright').LaunchOptions} */
  const launchOpts = {
    channel,
    headless,
    viewport: null,
    acceptDownloads: true,
  };
  // Opt-in touch-only (tablet-class) configuration: it has no mouse. Off by default:
  // a desktop that reports maxTouchPoints=0 must never receive touch input (see src/touch.js).
  if (touchMode) launchOpts.hasTouch = true;

  // Strip --no-sandbox from Patchright's default args unless we're in an
  // environment that genuinely needs it (root Linux / Docker, where the
  // kernel-level sandbox is unavailable and Chrome won't start without the
  // flag). Default-off keeps the renderer sandbox on and avoids Chrome's
  // warning bar.
  const isRootLinux = process.platform === 'linux'
    && typeof process.getuid === 'function' && process.getuid() === 0;
  const keepNoSandbox = isRootLinux || envFlag('ALLOW_NO_SANDBOX');
  if (!keepNoSandbox) {
    launchOpts.ignoreDefaultArgs = ['--no-sandbox'];
  }

  // Only pass an explicit executablePath when the user didn't ask us to
  // skip discovery (useful on CI where Patchright resolves bundled Chromium).
  if (!envFlag('NO_EXEC_PATH')) {
    const exe = cfg.chromeExecutable();
    if (exe) launchOpts.executablePath = exe;
  }

  // Measure the timer granularity in the background while the browser starts (the event loop is idle then):
  // timing.preciseSleep needs it to know how long a tail to spin instead of sleeping.
  timing.measureGranularity()
    .then((g) => cfg.appendLog(`timer granularity ${g} ms`))
    .catch((e) => cfg.appendLog(`timer granularity not measured (${e.message}); using the platform default`));

  let context;
  try {
    context = await chromium.launchPersistentContext(cfg.userDataDir(), launchOpts);
  } catch (e) {
    cfg.appendLog(`launchPersistentContext failed: ${e.message}`);
    process.stderr.write(`failed to launch browser: ${e.message}\n`);
    process.exit(2);
  }
  session.setContext(context);

  // Browser-level CDP session: needed to open each page in its own window.
  try {
    const b = context.browser();
    if (b && typeof b.newBrowserCDPSession === 'function') {
      session.setBrowserCdp(await b.newBrowserCDPSession());
    } else {
      cfg.appendLog('browser-level CDP session unavailable; new pages will open as tabs');
    }
  } catch (e) {
    cfg.appendLog(`browser-level CDP session failed: ${e.message}; new pages will open as tabs`);
  }

  // The initial page becomes the keeper; any extra initial pages are adopted.
  const initial = context.pages();
  // Pin the event clock BEFORE the keeper is minimized (a visible page surely takes input): one timestamped mouse
  // event on the daemon's OWN keeper page - never a website's - makes Chrome freeze its clock offset at the instant
  // ours is anchored (see src/timing.js). A failure is logged, not fatal.
  if (initial.length) await pinEventClock(initial[0]);
  if (initial.length) await session.setupKeeper(initial[0]);
  for (const p of initial.slice(1)) session.adoptPage(p);

  // Pages the daemon didn't create itself (popups, window.open, a person
  // opening a tab) are adopted too, tagged with their opener when known.
  context.on('page', (page) => {
    (async () => {
      let openerId = null, cwd = null;
      try {
        const op = await page.opener();
        const orec = op ? session.findRec(op) : null;
        if (orec) { openerId = orec.id; cwd = orec.cwd; }
      } catch { /* ignore */ }
      session.adoptPage(page, { opener: openerId, cwd });
      session.applyTouch(page);
    })();
  });

  // ---- http server -------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/ping') return send(res, 200, { ok: true, pong: true });

      if (req.method === 'POST' && req.url === '/shutdown') {
        const body = await jsonBody(req).catch(() => ({}));
        const n = session.pageCount();
        if (n > 0 && !body.force) {
          return send(res, 200, {
            ok: false,
            error: `${n} page(s) still open (${session.pageIds().join(', ')}) — close them, or stop --force to shut down anyway`,
            pages: session.pageIds(),
          });
        }
        send(res, 200, { ok: true, forced: !!body.force, closedPages: n });
        setTimeout(() => shutdown(0), 20);
        return;
      }

      if (req.method === 'POST' && req.url === '/cmd') {
        const body = await jsonBody(req);
        const cmd = body && body.cmd;
        const args = (body && body.args) || {};
        const cwd = (body && body.cwd) || null;
        const handler = commands[cmd];
        if (!handler) return send(res, 400, { ok: false, error: `unknown command: ${cmd}` });
        const startedMs = Date.now();
        let targetId = null;
        try {
          let result;
          if (PAGELESS.has(cmd)) {
            result = await session.metaQueue(() => handler({ session, cwd }, args));
          } else {
            const rec = session.resolve(args);
            targetId = rec.id;
            // The ctx is built when the job RUNS (inside this page's queue), so
            // the frame scope reflects any earlier `frame` command on the page.
            result = await rec.queue(() => handler({
              session, rec, page: rec.page,
              scope: session.frameOf(rec) || rec.page,
              cwd: cwd || rec.cwd,
            }, args));
          }
          const durMs = Date.now() - startedMs;
          session.logCommand({ at: new Date().toISOString(), cmd, page: targetId, args, ok: true, durMs });
          cfg.appendLog(`${targetId ? `[${targetId}] ` : ''}${cmd} ok ${durMs}ms`);
          return send(res, 200, { ok: true, page: targetId, result });
        } catch (e) {
          const durMs = Date.now() - startedMs;
          const cleanMsg = stripAnsi(e.message || String(e));
          session.logCommand({ at: new Date().toISOString(), cmd, page: targetId, args, ok: false, durMs, error: cleanMsg });
          cfg.appendLog(`${targetId ? `[${targetId}] ` : ''}${cmd} ERR ${durMs}ms ${cleanMsg}`);
          return send(res, 200, { ok: false, page: targetId, error: cleanMsg, stack: stripAnsi(e.stack || '') });
        }
      }

      return send(res, 404, { ok: false, error: `no route for ${req.method} ${req.url}` });
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message, stack: e.stack });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  await cfg.writeLockfile({
    pid: process.pid,
    port,
    profile: cfg.PROFILE || 'default',
    userDataDir: cfg.userDataDir(),
    startedAt: new Date().toISOString(),
    scriptPath,
    node: process.version,
  });
  await cfg.writeInstallFile(scriptPath);
  cfg.appendLog(`daemon listening pid=${process.pid} port=${port}`);
  process.stdout.write(
    `nativewright daemon ready profile=${cfg.PROFILE || 'default'} pid=${process.pid} port=${port} ` +
    `userDataDir="${cfg.userDataDir()}" idleExitMs=${cfg.IDLE_EXIT_MS}\n`
  );

  let shuttingDown = false;
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    cfg.appendLog(`shutdown code=${code}`);
    try { server.close(); } catch {}
    try { require('./clipboard').dispose(); } catch {}
    try { await context.close(); } catch (e) { cfg.appendLog(`context close error: ${e.message}`); }
    try { await cfg.deleteLockfile(); } catch {}
    process.exit(code);
  }
  session.setShutdown(shutdown);

  process.on('SIGINT',  () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGBREAK', () => shutdown(0));
  process.on('uncaughtException',  (e) => { cfg.appendLog(`uncaught: ${e.stack || e.message}`); });
  process.on('unhandledRejection', (e) => { cfg.appendLog(`unhandled: ${e && (e.stack || e.message) || e}`); });
  context.on('close', () => {
    cfg.appendLog('context closed by browser — shutting down');
    shutdown(0);
  });
}

module.exports = { runDaemon };
