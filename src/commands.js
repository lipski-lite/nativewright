'use strict';

// Browser command implementations. Each command receives (session, args) and
// returns a plain JSON-serializable result or throws. The daemon wraps the
// return in {ok:true, result} and any throw in {ok:false, error}.

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const { artifactsDir, ensureDir, makeArtifactName } = require('./config');
const human = require('./human');

// Human-layer is ON BY DEFAULT for every interaction command. Callers opt
// out per-call with `--raw=true` for rare cases where robotic precision is
// required (invisible elements, programmatic fills, automated logins that
// would be suspicious if slow). See `humanOpts` below — it centralizes the
// decision so it's impossible to accidentally skip the layer.
function isRaw(args) {
  if (args == null) return false;
  const v = args.raw;
  return v === true || v === 'true' || v === '1';
}

function humanOpts(args) {
  return {
    rng: human.makeRng(args.seed),
    timeout: Number(args.timeout) || 30000,
  };
}

// -------- helpers ----------------------------------------------------------

function requirePage(session) {
  const page = session.activePage();
  if (!page) throw new Error('no active page; run `new` first');
  return page;
}

function requireSelector(args) {
  if (!args.selector) throw new Error('selector required');
  return args.selector;
}

function scope(session) {
  // return the current interaction target: a Frame if set, else the Page
  return session.activeFrame() || requirePage(session);
}

function scopeForScreenshot(session) {
  // screenshots are always page-level, even if a frame is scoped
  return requirePage(session);
}

function withTimeout(args, fallback = 30000) {
  if (args.timeout == null) return fallback;
  const n = Number(args.timeout);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad timeout: ${args.timeout}`);
  return n;
}

// -------- command table ----------------------------------------------------

const commands = {
  // ---- pages --------------------------------------------------------------

  async new(session) {
    const page = await session.newPage();
    await session.ensureConsoleHook(page);
    return { index: session.pageIndex(page), url: page.url() };
  },

  async pages(session) {
    return session.listPages();
  },

  async switch(session, args) {
    if (args.index == null) throw new Error('index required');
    session.setActivePage(Number(args.index));
    return { activeIndex: session.activeIndex() };
  },

  async 'close-page'(session) {
    return session.closeActivePage();
  },

  // ---- navigation ---------------------------------------------------------

  async goto(session, args) {
    if (!args.url) throw new Error('url required');
    const page = requirePage(session);
    const resp = await page.goto(args.url, {
      timeout: withTimeout(args),
      waitUntil: args.waitUntil || 'load',
    });
    await session.ensureConsoleHook(page);
    // Post-load idle: real users spend a moment orienting before any
    // interaction. Skipped on raw:true for scraping scenarios.
    if (!isRaw(args)) {
      await human.sleep(human.thinkMs({ rng: human.makeRng(args.seed), mean: 900 }));
    }
    return { url: page.url(), status: resp ? resp.status() : null };
  },

  async back(session, args) {
    const page = requirePage(session);
    await page.goBack({ timeout: withTimeout(args) });
    await session.ensureConsoleHook(page);
    return { url: page.url() };
  },

  async forward(session, args) {
    const page = requirePage(session);
    await page.goForward({ timeout: withTimeout(args) });
    await session.ensureConsoleHook(page);
    return { url: page.url() };
  },

  async reload(session, args) {
    const page = requirePage(session);
    await page.reload({ timeout: withTimeout(args) });
    await session.ensureConsoleHook(page);
    return { url: page.url() };
  },

  // ---- interaction --------------------------------------------------------

  async click(session, args) {
    const sel = requireSelector(args);
    const target = scope(session);
    const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
    const clickCount = Math.max(1, Math.min(3, Number(args.clickCount) || 1));
    if (isRaw(args)) {
      await target.click(sel, {
        timeout: withTimeout(args), button, clickCount,
      });
      return { selector: sel, raw: true };
    }
    const page = requirePage(session);
    const opts = Object.assign(humanOpts(args), { button, clickCount });
    const tele = await human.humanClick(page, target.locator(sel), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel, button, clickCount, ...tele };
  },

  async dblclick(session, args) {
    args = Object.assign({}, args, { clickCount: 2 });
    return commands.click(session, args);
  },

  async rightclick(session, args) {
    args = Object.assign({}, args, { button: 'right' });
    return commands.click(session, args);
  },

  async fill(session, args) {
    const sel = requireSelector(args);
    if (args.value == null) throw new Error('value required');
    const target = scope(session);
    if (isRaw(args)) {
      await target.fill(sel, String(args.value), { timeout: withTimeout(args) });
      return { selector: sel, raw: true };
    }
    // Human fill: triple-click-select + Ctrl+A fallback (handles React-
    // controlled inputs and contenteditable), then type the new value with
    // realistic keystroke cadence and per-key dwell.
    const page = requirePage(session);
    const opts = humanOpts(args);
    const locator = target.locator(sel);
    await human.humanClearField(page, locator, opts);
    await human.sleep(human.logNormal(opts.rng, 90, 0.3, 30, 200));
    await human.humanType(page, String(args.value), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel };
  },

  async type(session, args) {
    const sel = requireSelector(args);
    if (args.text == null) throw new Error('text required');
    const target = scope(session);
    if (isRaw(args)) {
      const locator = target.locator(sel);
      if (typeof locator.pressSequentially === 'function') {
        await locator.pressSequentially(String(args.text), {
          delay: args.delay || 0, timeout: withTimeout(args),
        });
      } else {
        await target.type(sel, String(args.text), {
          delay: args.delay || 0, timeout: withTimeout(args),
        });
      }
      return { selector: sel, raw: true };
    }
    const page = requirePage(session);
    const opts = humanOpts(args);
    // Focus the field by clicking it first — this matches how a real user
    // puts the caret in the element before typing.
    await human.humanClick(page, target.locator(sel), opts);
    await human.sleep(human.logNormal(opts.rng, 100, 0.3, 40, 250));
    await human.humanType(page, String(args.text), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel };
  },

  async press(session, args) {
    if (!args.key) throw new Error('key required (e.g. Enter, Control+A)');
    const page = requirePage(session);
    const opts = humanOpts(args);
    if (!isRaw(args)) {
      // tiny hesitation before a hotkey; humans don't fire keys instantly
      // after the previous action completes
      await human.sleep(human.logNormal(opts.rng, 120, 0.35, 40, 400));
    }
    await page.keyboard.press(args.key);
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { key: args.key };
  },

  async hover(session, args) {
    const sel = requireSelector(args);
    const target = scope(session);
    if (isRaw(args)) {
      await target.hover(sel, { timeout: withTimeout(args) });
      return { selector: sel, raw: true };
    }
    const page = requirePage(session);
    const opts = humanOpts(args);
    await human.humanHover(page, target.locator(sel), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel };
  },

  async select(session, args) {
    const sel = requireSelector(args);
    if (args.value == null) throw new Error('value required');
    const selected = await scope(session).selectOption(sel, args.value, {
      timeout: withTimeout(args),
    });
    return { selector: sel, selected };
  },

  async scroll(session, args) {
    const page = requirePage(session);
    const where = (args.direction || args.where || 'down').toString();
    const raw = isRaw(args);
    const opts = humanOpts(args);

    // "top" and "bottom" are logical jumps; we still animate them in human
    // mode by wheeling in the right direction until the scroll settles,
    // capped at a reasonable max to avoid runaway loops on infinite pages.
    if (where === 'top') {
      if (raw) await page.evaluate(() => window.scrollTo(0, 0));
      else await human.humanScroll(page, -100000, opts);
      return { scrolledBy: 'top', where };
    }
    if (where === 'bottom') {
      if (raw) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      else await human.humanScroll(page, 100000, opts);
      return { scrolledBy: 'bottom', where };
    }

    let dy = 0;
    if (where === 'up')        dy = -600;
    else if (where === 'down') dy =  600;
    else if (/^-?\d+$/.test(where)) dy = parseInt(where, 10);
    else throw new Error(`bad scroll target: ${where}`);

    if (dy === 0) return { scrolledBy: 0, where };
    if (raw) {
      await page.evaluate((y) => window.scrollBy(0, y), dy);
    } else {
      await human.humanScroll(page, dy, opts);
      await human.sleep(human.thinkMs(opts));
    }
    return { scrolledBy: dy, where };
  },

  async upload(session, args) {
    const sel = requireSelector(args);
    if (!args.path) throw new Error('path required');
    const abs = path.resolve(args.path);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    await scope(session).setInputFiles(sel, abs, { timeout: withTimeout(args) });
    return { selector: sel, file: abs };
  },

  // ---- waiting ------------------------------------------------------------

  async wait(session, args) {
    const ms = Number(args.ms);
    if (!Number.isFinite(ms) || ms < 0) throw new Error('ms required');
    await new Promise((r) => setTimeout(r, ms));
    return { waited: ms };
  },

  async 'wait-for'(session, args) {
    const sel = requireSelector(args);
    const page = requirePage(session);
    const state = args.state || 'visible';
    await page.waitForSelector(sel, { state, timeout: withTimeout(args) });
    return { selector: sel, state };
  },

  async 'wait-for-load'(session, args) {
    const page = requirePage(session);
    const state = args.state || 'load';
    await page.waitForLoadState(state, { timeout: withTimeout(args) });
    return { state };
  },

  // ---- inspection ---------------------------------------------------------

  async text(session, args) {
    const target = scope(session);
    if (args.selector) {
      const t = await target.locator(args.selector).innerText({ timeout: withTimeout(args) });
      return { selector: args.selector, text: t };
    }
    const body = requirePage(session).locator('body');
    return { text: await body.innerText({ timeout: withTimeout(args) }) };
  },

  async html(session, args) {
    const target = scope(session);
    if (args.selector) {
      const h = await target.locator(args.selector).first().evaluate((el) => el.outerHTML, undefined, {
        timeout: withTimeout(args),
      });
      return { selector: args.selector, html: h };
    }
    const page = requirePage(session);
    return { html: await page.content() };
  },

  async title(session) {
    return { title: await requirePage(session).title() };
  },

  async url(session) {
    return { url: requirePage(session).url() };
  },

  async get(session, args) {
    const sel = requireSelector(args);
    if (!args.attr) throw new Error('attr required');
    const value = await scope(session).locator(sel).first().getAttribute(args.attr, {
      timeout: withTimeout(args),
    });
    return { selector: sel, attr: args.attr, value };
  },

  async count(session, args) {
    const sel = requireSelector(args);
    const n = await scope(session).locator(sel).count();
    return { selector: sel, count: n };
  },

  async eval(session, args) {
    if (!args.js) throw new Error('js required');
    const page = requirePage(session);
    // Wrap so a bare expression also works
    const wrapped = `(async()=>{ return (${args.js}); })()`;
    let value;
    try {
      value = await page.evaluate(wrapped);
    } catch (e) {
      // Fallback: maybe it's a statement, not an expression
      const wrapped2 = `(async()=>{ ${args.js} })()`;
      value = await page.evaluate(wrapped2);
    }
    return { value: value === undefined ? null : value };
  },

  // Read a JS file from disk and evaluate its FULL contents as ONE expression in
  // the page's evaluate context. Unlike `eval` (which carries JS as a CLI arg,
  // capped by the OS command-line length limit ~32KB), this reads the file
  // in-process, so a large self-contained script (e.g. the ~550KB axe-core
  // source + an axe.run() call wrapped in one async IIFE) is injected AND run in
  // a single evaluate call. That single-call requirement matters because
  // Patchright runs evaluate in an isolated world: a library defined by a
  // separate <script>/evaluate is invisible to later evaluate calls, so it must
  // be defined and used within the same evaluate. CDP evaluate also bypasses
  // page CSP, so this works on sites that block injected <script> tags.
  // The file MUST be a single self-contained JS expression (e.g. an async IIFE).
  async 'eval-file'(session, args) {
    if (!args.path) throw new Error('path required');
    const page = requirePage(session);
    const abs = path.resolve(args.path);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    const code = fs.readFileSync(abs, 'utf8');
    const value = await page.evaluate(code);
    return { value: value === undefined ? null : value };
  },

  async cookies(session, args) {
    const context = session.context();
    const urls = args.url ? [args.url] : undefined;
    return { cookies: await context.cookies(urls) };
  },

  // ---- frames & dialogs ---------------------------------------------------

  async frame(session, args) {
    if (args.reset || args.name === '' || args.index === -1) {
      session.clearFrame();
      return { frame: null };
    }
    if (args.name != null) {
      session.setFrameByName(String(args.name));
      return { frame: { name: String(args.name) } };
    }
    if (args.index != null) {
      session.setFrameByIndex(Number(args.index));
      return { frame: { index: Number(args.index) } };
    }
    throw new Error('frame: provide name, index, or reset=true');
  },

  async dialog(session, args) {
    const action = args.action || args.mode || 'dismiss';
    if (!['accept', 'dismiss'].includes(action)) throw new Error('dialog action must be accept|dismiss');
    session.setDialogPolicy({ action, promptText: args.promptText });
    return { policy: { action, promptText: args.promptText || null } };
  },

  // ---- artifacts ----------------------------------------------------------

  async shot(session, args) {
    const page = scopeForScreenshot(session);
    const dir  = artifactsDir();
    ensureDir(dir);
    const base = makeArtifactName(args.name);
    const file = path.join(dir, `${base}.png`);
    await page.screenshot({ path: file, fullPage: !!args.fullPage });
    return { path: file, url: page.url() };
  },

  async 'save-artifact'(session, args) {
    const page = scopeForScreenshot(session);
    const dir  = artifactsDir();
    ensureDir(dir);
    const base = makeArtifactName(args.name);
    const png  = path.join(dir, `${base}.png`);
    const html = path.join(dir, `${base}.html`);
    const meta = path.join(dir, `${base}.json`);
    await page.screenshot({ path: png, fullPage: !!args.fullPage });
    const content = await page.content();
    await fsp.writeFile(html, content, 'utf8');
    const info = {
      savedAt: new Date().toISOString(),
      url: page.url(),
      title: await page.title().catch(() => null),
      viewport: page.viewportSize(),
      name: args.name || null,
    };
    await fsp.writeFile(meta, JSON.stringify(info, null, 2));
    return { png, html, meta, url: info.url };
  },

  // ---- diagnostics --------------------------------------------------------

  async console(session, args) {
    const n = args.n != null ? Number(args.n) : 50;
    const page = requirePage(session);
    // Patchright stealth disables CDP console events; we read from the
    // in-page ring buffer instead. Re-inject the hook in case this page
    // was navigated without going through our goto handler.
    try {
      await session.ensureConsoleHook(page);
      const drained = await page.evaluate(() => {
        const b = window.__nativewright_console__ || [];
        const copy = b.slice();
        b.length = 0;
        return copy;
      });
      session.appendConsole(drained);
    } catch {/* page may be navigating; ignore */}
    return { messages: session.consoleBuffer(n) };
  },

  async 'network-log'(session, args) {
    const n = args.n != null ? Number(args.n) : 50;
    return { entries: session.networkBuffer(n) };
  },

  async downloads(session, args) {
    const n = args.n != null ? Number(args.n) : 50;
    return { downloads: session.downloadsBuffer(n) };
  },

  async state(session) {
    return session.snapshot();
  },

  async help() {
    return { commands: Object.keys(commands).sort() };
  },

  // ---- viewport (stealth-risky) ------------------------------------------

  async viewport(session, args) {
    const w = Number(args.w), h = Number(args.h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('w and h required');
    if (!args.force) throw new Error('viewport is stealth-risky; pass force=true to override');
    const page = requirePage(session);
    await page.setViewportSize({ width: w, height: h });
    return { viewport: { width: w, height: h }, warning: 'fixed viewport weakens stealth' };
  },

  async ping() { return { pong: true, at: new Date().toISOString() }; },
};

module.exports = { commands };
