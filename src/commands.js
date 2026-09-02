'use strict';

/**
 * Browser command implementations. Each command receives (ctx, args) and
 * returns a plain JSON-serializable result or throws. The daemon wraps the
 * return in {ok:true, result} and any throw in {ok:false, error}.
 *
 * ctx for page-targeted commands: { session, rec, page, scope, cwd }
 *   rec   — the page record: stable id + per-page buffers / frame / dialog state
 *   page  — the Playwright Page
 *   scope — interaction target: the scoped Frame if one is set, else the page
 *   cwd   — the requesting client's working directory (artifacts go there)
 * ctx for pageless commands: { session, cwd }
 *
 * @module commands
 */

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const { artifactsDir, ensureDir, makeArtifactName } = require('./config');
const human = require('./human');

/** Commands that do not target a page; the daemon never requires --page for them. */
const PAGELESS = new Set(['new', 'pages', 'state', 'help', 'ping', 'cookies', 'switch']);

// Human-layer is ON BY DEFAULT for every interaction command. Callers opt
// out per-call with `--raw=true` when robotic precision is required
// (invisible elements, programmatic fills). `humanOpts` centralizes the
// decision so the layer can't be skipped by accident.
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

function requireSelector(args) {
  if (!args.selector) throw new Error('selector required');
  return args.selector;
}

function withTimeout(args, fallback = 30000) {
  if (args.timeout == null) return fallback;
  const n = Number(args.timeout);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad timeout: ${args.timeout}`);
  return n;
}

const commands = {
  // ---- pages --------------------------------------------------------------

  async new(ctx, args) {
    const rec = await ctx.session.newPage({
      label: args.label != null ? String(args.label) : null,
      window: !(args.window === 'false' || args.window === false || args.window === '0'),
      cwd: ctx.cwd,
    });
    await ctx.session.ensureConsoleHook(rec.page);
    return {
      page: rec.id,
      url: rec.page.url(),
      windowId: rec.windowId,
      label: rec.label,
      hint: 'pass --page=' + rec.id + ' on every command for this page; run `close --page=' + rec.id + '` when done',
    };
  },

  async pages(ctx) {
    return ctx.session.listPages();
  },

  async switch() {
    throw new Error(
      '`switch` no longer exists: there is no shared active page. ' +
      'Target a page explicitly with --page=<id> on each command (ids come from `new` / `pages`).'
    );
  },

  async close(ctx) {
    return ctx.session.closePage(ctx.rec);
  },

  async 'close-page'(ctx) {
    return ctx.session.closePage(ctx.rec);
  },

  // ---- navigation ---------------------------------------------------------

  async goto(ctx, args) {
    if (!args.url) throw new Error('url required');
    const { page } = ctx;
    const resp = await page.goto(args.url, {
      timeout: withTimeout(args),
      waitUntil: args.waitUntil || 'load',
    });
    await ctx.session.ensureConsoleHook(page);
    // Post-load idle: a person orients for a moment before acting.
    if (!isRaw(args)) {
      await human.sleep(human.thinkMs({ rng: human.makeRng(args.seed), mean: 900 }));
    }
    return { url: page.url(), status: resp ? resp.status() : null };
  },

  async back(ctx, args) {
    await ctx.page.goBack({ timeout: withTimeout(args) });
    await ctx.session.ensureConsoleHook(ctx.page);
    return { url: ctx.page.url() };
  },

  async forward(ctx, args) {
    await ctx.page.goForward({ timeout: withTimeout(args) });
    await ctx.session.ensureConsoleHook(ctx.page);
    return { url: ctx.page.url() };
  },

  async reload(ctx, args) {
    await ctx.page.reload({ timeout: withTimeout(args) });
    await ctx.session.ensureConsoleHook(ctx.page);
    return { url: ctx.page.url() };
  },

  // ---- interaction --------------------------------------------------------

  async click(ctx, args) {
    const sel = requireSelector(args);
    const target = ctx.scope;
    const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
    const clickCount = Math.max(1, Math.min(3, Number(args.clickCount) || 1));
    if (isRaw(args)) {
      await target.click(sel, { timeout: withTimeout(args), button, clickCount });
      return { selector: sel, raw: true };
    }
    const opts = Object.assign(humanOpts(args), { button, clickCount });
    const tele = await human.humanClick(ctx.page, target.locator(sel), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel, button, clickCount, ...tele };
  },

  async dblclick(ctx, args) {
    return commands.click(ctx, Object.assign({}, args, { clickCount: 2 }));
  },

  async rightclick(ctx, args) {
    return commands.click(ctx, Object.assign({}, args, { button: 'right' }));
  },

  async fill(ctx, args) {
    const sel = requireSelector(args);
    if (args.value == null) throw new Error('value required');
    const target = ctx.scope;
    if (isRaw(args)) {
      await target.fill(sel, String(args.value), { timeout: withTimeout(args) });
      return { selector: sel, raw: true };
    }
    const opts = humanOpts(args);
    const locator = target.locator(sel);
    await human.humanClearField(ctx.page, locator, opts);
    await human.sleep(human.logNormal(opts.rng, 90, 0.3, 30, 200));
    await human.humanType(ctx.page, String(args.value), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel };
  },

  async type(ctx, args) {
    const sel = requireSelector(args);
    if (args.text == null) throw new Error('text required');
    const target = ctx.scope;
    if (isRaw(args)) {
      const locator = target.locator(sel);
      if (typeof locator.pressSequentially === 'function') {
        await locator.pressSequentially(String(args.text), { delay: args.delay || 0, timeout: withTimeout(args) });
      } else {
        await target.type(sel, String(args.text), { delay: args.delay || 0, timeout: withTimeout(args) });
      }
      return { selector: sel, raw: true };
    }
    const opts = humanOpts(args);
    await human.humanClick(ctx.page, target.locator(sel), opts);
    await human.sleep(human.logNormal(opts.rng, 100, 0.3, 40, 250));
    await human.humanType(ctx.page, String(args.text), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel };
  },

  async press(ctx, args) {
    if (!args.key) throw new Error('key required (e.g. Enter, Control+A)');
    const opts = humanOpts(args);
    if (!isRaw(args)) await human.sleep(human.logNormal(opts.rng, 120, 0.35, 40, 400));
    await ctx.page.keyboard.press(args.key);
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { key: args.key };
  },

  async hover(ctx, args) {
    const sel = requireSelector(args);
    const target = ctx.scope;
    if (isRaw(args)) {
      await target.hover(sel, { timeout: withTimeout(args) });
      return { selector: sel, raw: true };
    }
    const opts = humanOpts(args);
    await human.humanHover(ctx.page, target.locator(sel), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel };
  },

  async select(ctx, args) {
    const sel = requireSelector(args);
    if (args.value == null) throw new Error('value required');
    const selected = await ctx.scope.selectOption(sel, args.value, { timeout: withTimeout(args) });
    return { selector: sel, selected };
  },

  async scroll(ctx, args) {
    const { page } = ctx;
    const where = (args.direction || args.where || 'down').toString();
    const raw = isRaw(args);
    const opts = humanOpts(args);

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

  async upload(ctx, args) {
    const sel = requireSelector(args);
    if (!args.path) throw new Error('path required');
    const abs = path.resolve(ctx.cwd || process.cwd(), args.path);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    await ctx.scope.setInputFiles(sel, abs, { timeout: withTimeout(args) });
    return { selector: sel, file: abs };
  },

  // ---- waiting ------------------------------------------------------------

  async wait(ctx, args) {
    const ms = Number(args.ms);
    if (!Number.isFinite(ms) || ms < 0) throw new Error('ms required');
    await new Promise((r) => setTimeout(r, ms));
    return { waited: ms };
  },

  async 'wait-for'(ctx, args) {
    const sel = requireSelector(args);
    const state = args.state || 'visible';
    await ctx.page.waitForSelector(sel, { state, timeout: withTimeout(args) });
    return { selector: sel, state };
  },

  async 'wait-for-load'(ctx, args) {
    const state = args.state || 'load';
    await ctx.page.waitForLoadState(state, { timeout: withTimeout(args) });
    return { state };
  },

  // ---- inspection ---------------------------------------------------------

  async text(ctx, args) {
    if (args.selector) {
      const t = await ctx.scope.locator(args.selector).innerText({ timeout: withTimeout(args) });
      return { selector: args.selector, text: t };
    }
    return { text: await ctx.page.locator('body').innerText({ timeout: withTimeout(args) }) };
  },

  async html(ctx, args) {
    if (args.selector) {
      const h = await ctx.scope.locator(args.selector).first().evaluate((el) => el.outerHTML, undefined, {
        timeout: withTimeout(args),
      });
      return { selector: args.selector, html: h };
    }
    return { html: await ctx.page.content() };
  },

  async title(ctx) {
    return { title: await ctx.page.title() };
  },

  async url(ctx) {
    return { url: ctx.page.url() };
  },

  async get(ctx, args) {
    const sel = requireSelector(args);
    if (!args.attr) throw new Error('attr required');
    const value = await ctx.scope.locator(sel).first().getAttribute(args.attr, { timeout: withTimeout(args) });
    return { selector: sel, attr: args.attr, value };
  },

  async count(ctx, args) {
    const sel = requireSelector(args);
    const n = await ctx.scope.locator(sel).count();
    return { selector: sel, count: n };
  },

  async eval(ctx, args) {
    if (!args.js) throw new Error('js required');
    const { page } = ctx;
    const wrapped = `(async()=>{ return (${args.js}); })()`;
    let value;
    try {
      value = await page.evaluate(wrapped);
    } catch (e) {
      const wrapped2 = `(async()=>{ ${args.js} })()`;
      value = await page.evaluate(wrapped2);
    }
    return { value: value === undefined ? null : value };
  },

  // Evaluate a JS FILE's full contents in the page context in ONE
  // page.evaluate — for injecting libraries / probes too large for a CLI
  // argument. Any helper functions must be defined and used within the same
  // evaluate. CDP evaluate bypasses page CSP, so this works on sites that
  // block injected <script> tags. The file MUST be a single self-contained JS
  // expression (e.g. an async IIFE). The path is resolved relative to the
  // caller's working directory.
  async 'eval-file'(ctx, args) {
    if (!args.path) throw new Error('path required');
    const abs = path.resolve(ctx.cwd || process.cwd(), args.path);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    const code = fs.readFileSync(abs, 'utf8');
    const value = await ctx.page.evaluate(code);
    return { value: value === undefined ? null : value };
  },

  async cookies(ctx, args) {
    const context = ctx.session.context();
    const urls = args.url ? [args.url] : undefined;
    return { cookies: await context.cookies(urls) };
  },

  // ---- frames & dialogs (per page) ---------------------------------------

  async frame(ctx, args) {
    if (args.reset || args.name === '' || args.index === -1) {
      ctx.rec.frameRef = null;
      return { frame: null };
    }
    if (args.name != null) {
      ctx.rec.frameRef = { type: 'name', value: String(args.name) };
      return { frame: { name: String(args.name) } };
    }
    if (args.index != null) {
      ctx.rec.frameRef = { type: 'index', value: Number(args.index) };
      return { frame: { index: Number(args.index) } };
    }
    throw new Error('frame: provide name, index, or reset=true');
  },

  async dialog(ctx, args) {
    const action = args.action || args.mode || 'dismiss';
    if (!['accept', 'dismiss'].includes(action)) throw new Error('dialog action must be accept|dismiss');
    ctx.rec.dialogPolicy = { action, promptText: args.promptText };
    return { policy: { action, promptText: args.promptText || null } };
  },

  // ---- artifacts (written under the requesting client's cwd) --------------

  async shot(ctx, args) {
    const dir = artifactsDir(ctx.cwd);
    ensureDir(dir);
    const base = makeArtifactName(args.name);
    const file = path.join(dir, `${base}.png`);
    await ctx.page.screenshot({ path: file, fullPage: !!args.fullPage });
    return { path: file, url: ctx.page.url() };
  },

  async 'save-artifact'(ctx, args) {
    const { page } = ctx;
    const dir = artifactsDir(ctx.cwd);
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
      page: ctx.rec.id,
      url: page.url(),
      title: await page.title().catch(() => null),
      viewport: page.viewportSize(),
      name: args.name || null,
    };
    await fsp.writeFile(meta, JSON.stringify(info, null, 2));
    return { png, html, meta, url: info.url };
  },

  async downloads(ctx, args) {
    const n = args.n != null ? Number(args.n) : 50;
    return { downloads: ctx.rec.downloads.slice(-n) };
  },

  // ---- diagnostics --------------------------------------------------------

  async console(ctx, args) {
    const n = args.n != null ? Number(args.n) : 50;
    const { page, rec } = ctx;
    try {
      await ctx.session.ensureConsoleHook(page);
      const drained = await page.evaluate(() => {
        const b = window.__nativewright_console__ || [];
        const copy = b.slice();
        b.length = 0;
        return copy;
      });
      for (const e of drained) rec.console.push(e);
      while (rec.console.length > 200) rec.console.shift();
    } catch { /* page may be navigating; ignore */ }
    return { messages: rec.console.slice(-n) };
  },

  async 'network-log'(ctx, args) {
    const n = args.n != null ? Number(args.n) : 50;
    return { entries: ctx.rec.network.slice(-n) };
  },

  async state(ctx) {
    return ctx.session.snapshot();
  },

  async help() {
    return { commands: Object.keys(commands).sort(), pageless: [...PAGELESS] };
  },

  async viewport(ctx, args) {
    const w = Number(args.w), h = Number(args.h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('w and h required');
    if (!args.force) throw new Error('viewport overrides the real window geometry; pass force=true to override');
    await ctx.page.setViewportSize({ width: w, height: h });
    return { viewport: { width: w, height: h }, warning: 'fixed viewport overrides the real window size' };
  },

  async ping() { return { pong: true, at: new Date().toISOString() }; },
};

module.exports = { commands, PAGELESS };
