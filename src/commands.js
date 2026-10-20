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
 * Coordinate commands (click-at, hover-at, element-at, drag-at, tap-at, ...)
 * always work at PAGE level and ignore the frame scope: raw input at page
 * coordinates is routed by Chrome into iframes, cross-origin ones included.
 *
 * @module commands
 */

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const { artifactsDir, ensureDir, makeArtifactName } = require('./config');
const human = require('./human');
const inspect = require('./inspect');
const coords = require('./coords');
const K = require('./keys');
const wheel = require('./wheel');
const touch = require('./touch');
const modality = require('./modality');
const filedrop = require('./filedrop');
const paste = require('./paste');
const clipboard = require('./clipboard');

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

/** A boolean flag: `--x`, `--x=true`, `--x=1`. (`--x=false` / `--x=0` are false.) */
function flag(v) { return v === true || v === 'true' || v === '1' || v === 1; }

function humanOpts(args) {
  return {
    rng: human.makeRng(args.seed),
    timeout: Number(args.timeout) || 30000,
  };
}

/** `--typos=on|off|auto`, validated (it used to be silently ignored). */
function parseTypos(args) {
  if (args.typos == null) return undefined;
  const v = String(args.typos).toLowerCase();
  if (v !== 'on' && v !== 'off' && v !== 'auto') throw new Error(`bad --typos '${args.typos}' (use on, off or auto)`);
  return v;
}

/** humanOpts + the typing options, for every path that types. */
function typingOpts(args) {
  const o = humanOpts(args);
  const typos = parseTypos(args);
  if (typos) o.typos = typos;
  return o;
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

// ---- strict argument parsers for the new commands ---------------------------

function parseButton(v) {
  if (v == null || v === true || v === '') return 'left';
  const s = String(v).toLowerCase();
  if (s !== 'left' && s !== 'right' && s !== 'middle') throw new Error(`bad --button '${v}' (use left, right or middle)`);
  return s;
}

function parseClickCount(v) {
  if (v == null || v === true || v === '') return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error(`bad --clickCount '${v}' (use 1, 2 or 3)`);
  return n;
}

/** `--hold=<ms>`: the button/key is held that long instead of the normal human dwell. */
function parseHold(v) {
  if (v == null) return undefined;
  const n = coords.parseNumber(v === true ? '' : v, '--hold');
  if (n < 0 || n > 600000) throw new Error(`bad --hold '${v}' (0..600000 ms)`);
  return n;
}

function parseRepeat(v) {
  if (v == null) return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error(`bad --repeat '${v}' (1..500)`);
  return n;
}

function parseModifiers(v) { return K.parseModifierList(v); }

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** A point snapped to the device-pixel grid of the viewport `vp` was measured on (human.q): integers at dpr 1, multiples of 1/dpr otherwise. */
const snapTo = (vp, p) => ({ x: human.q(p.x, vp.dpr), y: human.q(p.y, vp.dpr) });

/** --space, --at → what the selector commands pass down to human.js. */
function atOptions(args) {
  if (args.at == null) return {};
  return { at: coords.parseAt(args.at, '--at'), atSpace: coords.parseSpace(args.space), exact: flag(args.exact) };
}

/**
 * Input modality must match the fingerprint: a page that reports NO fine pointing device (the touch-only profile of
 * NATIVEWRIGHT_TOUCH=1) is never sent mouse input - clicks, hovers, drags, the wheel, nor the selector commands that
 * focus their field with a click (fill, type, select, paste <selector>). This applies to --raw as well; see ./modality.js.
 */
async function needMouse(ctx, what) { await modality.assertMouseCapable(ctx.page, what); }

/**
 * resolveBox options for a command that may have to scroll its target into view: wheel events on a normal profile,
 * finger drags (touch.scrollBy) when the page has no fine pointer. --raw never scrolls by input.
 */
async function scrollingOpts(ctx, args, rng) {
  if (isRaw(args)) return { page: null, rng };
  if (await modality.hasFinePointer(ctx.page)) return { page: ctx.page, rng };
  return { page: ctx.page, rng, scroll: (dy) => touch.scrollBy(ctx.page, dy, { rng }) };
}

/** Best-effort hit test (never throws). */
async function safeHit(page, x, y) {
  try { return await inspect.hitTest(page, x, y); }
  catch { return { hit: null, frames: [] }; }
}

/** Read the PNG header: { width, height } without decoding. */
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } finally { fs.closeSync(fd); }
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

  // ---- interaction: selector based ----------------------------------------

  async click(ctx, args) {
    const sel = requireSelector(args);
    await needMouse(ctx, args.button === 'right' ? 'rightclick' : Number(args.clickCount) === 2 ? 'dblclick' : 'click');
    const target = ctx.scope;
    const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
    const clickCount = Math.max(1, Math.min(3, Number(args.clickCount) || 1));
    const hold = parseHold(args.hold);
    const modifiers = parseModifiers(args.modifiers);
    const extra = atOptions(args);
    const flags = hold != null || modifiers.names.length > 0 || extra.at;
    if (isRaw(args)) {
      if (!flags) {
        await target.click(sel, { timeout: withTimeout(args), button, clickCount });
        return { selector: sel, raw: true };
      }
      const o = { timeout: withTimeout(args), button, clickCount };
      if (hold != null) o.delay = hold;
      if (modifiers.names.length) o.modifiers = modifiers.names;
      if (extra.at) {
        const loc = target.locator(sel);
        await loc.waitFor({ state: 'visible', timeout: o.timeout });
        const box = await loc.boundingBox({ timeout: o.timeout });
        if (!box) throw new Error('element has no bounding box (detached or 0-size)');
        const vp = await human.viewportMetrics(ctx.page);
        o.position = coords.resolveOffset(extra.at, extra.atSpace, vp, box);
      }
      await target.click(sel, o);
      return { selector: sel, raw: true };
    }
    const opts = Object.assign(humanOpts(args), { button, clickCount }, extra);
    if (hold != null) opts.hold = hold;
    if (modifiers.names.length) opts.modifiers = modifiers;
    const tele = await human.humanClick(ctx.page, target.locator(sel), opts);
    await human.sleep(human.thinkMs(opts));
    const res = { selector: sel, button, clickCount, ...tele };
    if (hold != null) res.hold = hold;
    if (modifiers.names.length) res.modifiers = modifiers.names;
    return res;
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
    await needMouse(ctx, 'fill');
    const target = ctx.scope;
    if (isRaw(args)) {
      await target.fill(sel, String(args.value), { timeout: withTimeout(args) });
      return { selector: sel, raw: true };
    }
    const opts = typingOpts(args);
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
    await needMouse(ctx, 'type');
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
    const opts = typingOpts(args);
    await human.humanClick(ctx.page, target.locator(sel), opts);
    await human.sleep(human.logNormal(opts.rng, 100, 0.3, 40, 250));
    await human.humanType(ctx.page, String(args.text), opts);
    await human.sleep(human.thinkMs(opts));
    return { selector: sel };
  },

  async hover(ctx, args) {
    const sel = requireSelector(args);
    await needMouse(ctx, 'hover');
    const target = ctx.scope;
    const extra = atOptions(args);
    if (isRaw(args)) {
      if (!extra.at) {
        await target.hover(sel, { timeout: withTimeout(args) });
        return { selector: sel, raw: true };
      }
      const loc = target.locator(sel);
      await loc.waitFor({ state: 'visible', timeout: withTimeout(args) });
      const box = await loc.boundingBox({ timeout: withTimeout(args) });
      if (!box) throw new Error('element has no bounding box (detached or 0-size)');
      const vp = await human.viewportMetrics(ctx.page);
      await target.hover(sel, { timeout: withTimeout(args), position: coords.resolveOffset(extra.at, extra.atSpace, vp, box) });
      return { selector: sel, raw: true };
    }
    const opts = Object.assign(humanOpts(args), extra);
    const tele = await human.humanHover(ctx.page, target.locator(sel), opts);
    await human.sleep(human.thinkMs(opts));
    return extra.at ? { selector: sel, landedAt: tele.landedAt } : { selector: sel };
  },

  // ---- interaction: keyboard ----------------------------------------------

  // A human key press. Mapped keys go through the CDP key emitter (real-time
  // dwell, Chrome stamps the events); combos `A+B+C` press modifiers first, release in reverse.
  //   --hold=<ms>   hold the main key; past ~500 ms it auto-repeats on a ~33 ms
  //                 timer with autoRepeat:true (a held printable key keeps
  //                 inserting its text, like real hardware: holding "a" in an
  //                 input types "aaaa...")
  //   --repeat=<n>  n presses with human gaps
  async press(ctx, args) {
    if (!args.key) throw new Error('key required (e.g. Enter, Control+A)');
    const hold = parseHold(args.hold);
    const repeat = parseRepeat(args.repeat);
    const opts = humanOpts(args);
    if (isRaw(args)) {
      for (let i = 0; i < repeat; i++) await ctx.page.keyboard.press(args.key, hold != null ? { delay: hold } : {});
      const res = { key: args.key };
      if (repeat > 1) res.repeat = repeat;
      if (hold != null) res.hold = hold;
      return res;
    }
    await human.sleep(human.logNormal(opts.rng, 120, 0.35, 40, 400));
    const r = await human.humanPress(ctx.page, args.key, { rng: opts.rng, hold, repeat });
    await human.sleep(human.thinkMs(opts));
    const res = { key: args.key };
    if (repeat > 1) res.repeat = repeat;
    if (hold != null) { res.hold = hold; res.autoRepeats = r.autoRepeats; }
    return res;
  },

  // Press and keep a key down; it stays down across commands until key-up / release.
  async 'key-down'(ctx, args) {
    if (!args.key) throw new Error('key required (e.g. Shift, Control, Alt, Meta, ArrowDown, a)');
    const { page } = ctx;
    const opts = humanOpts(args);
    const st = human.inputState(page);
    const spec = human.resolveKeyToken(String(args.key), st);       // throws a clear error for an unknown key
    const wasHeld = st.keys.has(spec.name);
    if (!isRaw(args)) await human.sleep(human.logNormal(opts.rng, 90, 0.35, 30, 250));
    if (spec.switchTo) await human.switchLayout(page, st, opts.rng, spec.switchTo);
    // a shifted character needs Shift: hold it too (it shows up in the held list)
    if (!spec.modifier && spec.desc.shift && !(st.modifiers & K.MOD_BITS.Shift)) {
      await human.pressModifier(page, 'Shift');
      await human.sleep(human.logNormal(opts.rng, 55, 0.35, 20, 160));
    }
    await human.keyDown(page, spec, { repeatIfHeld: true });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { key: spec.name, code: spec.desc.code, wasHeld, held: human.inputSnapshot(page).held };
  },

  async 'key-up'(ctx, args) {
    if (!args.key) throw new Error('key required');
    const { page } = ctx;
    const opts = humanOpts(args);
    const st = human.inputState(page);
    const spec = st.keyDescs.get(String(args.key)) || human.resolveKeyToken(String(args.key), st);
    const wasHeld = st.keys.has(spec.name);
    if (!isRaw(args)) await human.sleep(human.logNormal(opts.rng, 80, 0.35, 30, 220));
    if (wasHeld) await human.keyUp(page, spec);
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { key: spec.name, wasHeld, held: human.inputSnapshot(page).held };
  },

  // Human typing into whatever is focused (no click, no focus change). If
  // nothing editable is focused the key events still dispatch (canvas games
  // listen on window).
  async 'type-focused'(ctx, args) {
    if (args.text == null) throw new Error('text required');
    const { page } = ctx;
    const text = String(args.text);
    const focused = await inspect.focusedInfo(page);
    if (isRaw(args)) {
      await page.keyboard.type(text, { delay: Number(args.delay) || 0 });
    } else {
      const opts = typingOpts(args);
      await human.humanType(page, text, opts);
      await human.sleep(human.thinkMs(opts));
    }
    return { typed: human.splitGraphemes(text).length, focused: { tag: focused.tag, editable: focused.editable } };
  },

  // Real clipboard paste (OS clipboard + a human Ctrl+V); see src/paste.js.
  async paste(ctx, args) {
    const sel = requireSelector(args);
    await needMouse(ctx, 'paste');
    const text = readPasteText(ctx, args);
    const opts = typingOpts(args);
    prewarmClipboard(ctx);
    const loc = ctx.scope.locator(sel);
    if (isRaw(args)) await loc.focus({ timeout: withTimeout(args) });
    else {
      await human.humanClick(ctx.page, loc, opts);
      await human.sleep(human.logNormal(opts.rng, 110, 0.3, 40, 260));
    }
    const r = await paste.pasteFocused(ctx, text, { rng: opts.rng, typos: opts.typos, raw: isRaw(args) });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { selector: sel, ...r };
  },

  async 'paste-focused'(ctx, args) {
    const text = readPasteText(ctx, args);
    const opts = typingOpts(args);
    prewarmClipboard(ctx);
    const r = await paste.pasteFocused(ctx, text, { rng: opts.rng, typos: opts.typos, raw: isRaw(args) });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return r;
  },

  // ---- interaction: coordinates -------------------------------------------

  // Click at a viewport point. Hit-tests the point first (the Fitts target
  // width comes from the element found there), lands with a hand's tiny jitter
  // unless --exact, and reports where it landed.
  async 'click-at'(ctx, args) {
    const { page } = ctx;
    await needMouse(ctx, 'click-at');
    const space = coords.parseSpace(args.space);
    const vp = await human.viewportMetrics(page);
    const pt = coords.resolvePoint(args.x, args.y, space, vp);
    const button = parseButton(args.button);
    const clickCount = parseClickCount(args.clickCount);
    const hold = parseHold(args.hold);
    const modifiers = parseModifiers(args.modifiers);
    const exact = flag(args.exact);
    const { hit, frames } = await safeHit(page, pt.exact.x, pt.exact.y);
    const base = { requested: pt.requested, css: pt.css };

    if (isRaw(args)) {
      // --raw skips the human hand (no path, no jitter, no dwell) but not the device-pixel grid: a real mouse reports
      // physical pixels, so the point is snapped (integers at dpr 1, multiples of 1/dpr otherwise)
      const sp = snapTo(vp, pt.exact);
      const pressed = [];
      try {
        for (const m of modifiers.names) if (await human.pressModifier(page, m)) pressed.push(m);
        await page.mouse.click(sp.x, sp.y, { button, clickCount, ...(hold != null ? { delay: hold } : {}) });
      } finally {
        for (const m of pressed.reverse()) await human.releaseModifier(page, m).catch(() => {});
      }
      human.setPos(page, sp);
      human.inputState(page).synced = true;
      return { ...base, landedAt: { x: round3(sp.x), y: round3(sp.y) }, dpr: vp.dpr, hit, button, clickCount, raw: true };
    }

    const opts = humanOpts(args);
    const r = await human.humanClickAt(page, pt.exact.x, pt.exact.y, {
      rng: opts.rng, button, clickCount, hold, modifiers, exact, targetW: human.fittsWidth(hit), vp,
    });
    await human.sleep(human.thinkMs(opts));
    return {
      ...base, landedAt: r.landedAt, dpr: vp.dpr, hit, ...(frames.length ? { frames } : {}),
      button, clickCount, moveMs: r.moveMs, totalMs: r.totalMs,
    };
  },

  async 'hover-at'(ctx, args) {
    const { page } = ctx;
    await needMouse(ctx, 'hover-at');
    const space = coords.parseSpace(args.space);
    const vp = await human.viewportMetrics(page);
    const pt = coords.resolvePoint(args.x, args.y, space, vp);
    const exact = flag(args.exact);
    const { hit, frames } = await safeHit(page, pt.exact.x, pt.exact.y);
    const base = { requested: pt.requested, css: pt.css };
    if (isRaw(args)) {
      const sp = snapTo(vp, pt.exact);                    // on the device-pixel grid, like every pointer coordinate
      await page.mouse.move(sp.x, sp.y);
      human.setPos(page, sp);
      human.inputState(page).synced = true;
      return { ...base, landedAt: { x: round3(sp.x), y: round3(sp.y) }, dpr: vp.dpr, hit, raw: true };
    }
    const opts = humanOpts(args);
    const r = await human.humanHoverAt(page, pt.exact.x, pt.exact.y, { rng: opts.rng, exact, targetW: human.fittsWidth(hit), vp });
    await human.sleep(human.thinkMs(opts));
    return { ...base, landedAt: r.landedAt, dpr: vp.dpr, hit, ...(frames.length ? { frames } : {}), moveMs: r.moveMs };
  },

  // Read-only hit test: what is at this point? No input is dispatched.
  async 'element-at'(ctx, args) {
    const { page } = ctx;
    const space = coords.parseSpace(args.space);
    const vp = await human.viewportMetrics(page);
    const pt = coords.resolvePoint(args.x, args.y, space, vp);
    const { hit, frames } = await inspect.hitTest(page, pt.exact.x, pt.exact.y);
    return {
      requested: pt.requested, css: pt.css, dpr: vp.dpr,
      viewport: { width: vp.width, height: vp.height },
      hit, frames,
    };
  },

  // Drag between two elements (offsets via --from-at / --to-at, else a human landing point in each box).
  async drag(ctx, args) {
    const fromSel = args.from, toSel = args.to;
    if (!fromSel || !toSel) throw new Error('drag needs two selectors: drag <fromSelector> <toSelector>');
    const { page } = ctx;
    await needMouse(ctx, 'drag');
    const button = parseButton(args.button);
    const modifiers = parseModifiers(args.modifiers);
    const space = coords.parseSpace(args.space);
    const fromAt = args['from-at'] != null ? coords.parseAt(args['from-at'], '--from-at') : (args.fromAt != null ? coords.parseAt(args.fromAt, '--from-at') : null);
    const toAt = args['to-at'] != null ? coords.parseAt(args['to-at'], '--to-at') : (args.toAt != null ? coords.parseAt(args.toAt, '--to-at') : null);
    const timeout = withTimeout(args);
    const fromLoc = ctx.scope.locator(fromSel), toLoc = ctx.scope.locator(toSel);

    if (isRaw(args)) {
      if (button !== 'left') throw new Error('raw drag (Playwright dragTo) supports only the left button; use the human drag for --button=' + button);
      const vp = await human.viewportMetrics(page);
      const o = { timeout };
      if (fromAt || toAt) {
        await fromLoc.waitFor({ state: 'visible', timeout });
        await toLoc.waitFor({ state: 'visible', timeout });
        if (fromAt) o.sourcePosition = coords.resolveOffset(fromAt, space, vp, await fromLoc.boundingBox({ timeout }), '--from-at');
        if (toAt) o.targetPosition = coords.resolveOffset(toAt, space, vp, await toLoc.boundingBox({ timeout }), '--to-at');
      }
      const pressed = [];
      try {
        for (const m of modifiers.names) if (await human.pressModifier(page, m)) pressed.push(m);
        await fromLoc.dragTo(toLoc, o);
      } finally {
        for (const m of pressed.reverse()) await human.releaseModifier(page, m).catch(() => {});
      }
      return { from: { selector: fromSel }, to: { selector: toSel }, mode: 'raw', raw: true };
    }

    const opts = humanOpts(args);
    const rng = opts.rng;
    await human.resolveBox(fromLoc, timeout, { page, rng });
    await human.resolveBox(toLoc, timeout, { page, rng });
    // scrolling to the target may have moved the source: measure both again
    const fromBox = await fromLoc.boundingBox({ timeout });
    const toBox = await toLoc.boundingBox({ timeout });
    if (!fromBox || !toBox) throw new Error('drag source or target has no bounding box (detached or 0-size)');
    const vp = await human.viewportMetrics(page);
    // the landing points sit on the device-pixel grid (and so do the css values reported below)
    const landing = (box, at, label) => (at
      ? human.pointFromOffset(box, coords.resolveOffset(at, space, vp, box, label), rng, flag(args.exact), vp)
      : snapTo(vp, human.pointInBox(box, rng)));
    const from = landing(fromBox, fromAt, '--from-at');
    const to = landing(toBox, toAt, '--to-at');
    for (const [label, p] of [['source', from], ['target', to]]) {
      if (!(p.x >= 0 && p.x < vp.width && p.y >= 0 && p.y < vp.height)) {
        throw new Error(`drag ${label} point (${round1(p.x)}, ${round1(p.y)}) is outside the viewport (${vp.width}x${vp.height} CSS px, dpr ${vp.dpr}); ` +
          'source and target must be visible at the same time (resize the window or scroll so both fit)');
      }
    }
    const hitFrom = await safeHit(page, from.x, from.y);
    const hitTo = await safeHit(page, to.x, to.y);
    const html5 = !!(hitFrom.hit && hitFrom.hit.draggable);
    const r = await human.humanDrag(page, from, to, {
      rng, button, modifiers, html5, fromW: human.fittsWidth(hitFrom.hit), toW: human.fittsWidth(hitTo.hit),
    });
    await human.sleep(human.thinkMs(opts));
    return {
      from: { selector: fromSel, css: { x: round2(from.x), y: round2(from.y) } },
      to: { selector: toSel, css: { x: round2(to.x), y: round2(to.y) } },
      mode: html5 ? 'html5' : 'pointer', hitFrom: hitFrom.hit, hitTo: hitTo.hit, durationMs: r.durationMs,
    };
  },

  // Drag between two viewport points.
  async 'drag-at'(ctx, args) {
    const { page } = ctx;
    await needMouse(ctx, 'drag-at');
    const space = coords.parseSpace(args.space);
    const vp = await human.viewportMetrics(page);
    const a = coords.resolvePoint(args.x1, args.y1, space, vp, ['x1', 'y1']);
    const b = coords.resolvePoint(args.x2, args.y2, space, vp, ['x2', 'y2']);
    const button = parseButton(args.button);
    const modifiers = parseModifiers(args.modifiers);
    const hitFrom = await safeHit(page, a.exact.x, a.exact.y);
    const hitTo = await safeHit(page, b.exact.x, b.exact.y);
    const html5 = !!(hitFrom.hit && hitFrom.hit.draggable);
    const out = (mode, durationMs, extra = {}) => ({
      from: { css: a.css, requested: a.requested }, to: { css: b.css, requested: b.requested },
      mode, hitFrom: hitFrom.hit, hitTo: hitTo.hit, durationMs, ...extra,
    });

    if (isRaw(args)) {
      // robotic (no path shape, no pre-hold, no dwell) but on the device-pixel grid: both ends snapped, and the
      // intermediate steps too (Playwright's own `steps` interpolation would hand the page fractional coordinates)
      const sa = snapTo(vp, a.exact), sb = snapTo(vp, b.exact);
      const t0 = Date.now();
      const pressed = [];
      let down = false;
      try {
        for (const m of modifiers.names) if (await human.pressModifier(page, m)) pressed.push(m);
        await page.mouse.move(sa.x, sa.y);
        human.setPos(page, sa);
        human.inputState(page).synced = true;
        down = true;
        await human.mouseDown(page, button, 1);
        const steps = Math.max(5, Math.min(30, Math.round(Math.hypot(sb.x - sa.x, sb.y - sa.y) / 15)));
        await human.rawMove(page, sa, sb, steps);
        await human.mouseUp(page, button, 1);
        down = false;
      } finally {
        if (down) await human.mouseUp(page, button, 1).catch(() => {});
        for (const m of pressed.reverse()) await human.releaseModifier(page, m).catch(() => {});
      }
      human.setPos(page, sb);
      human.inputState(page).synced = true;
      return out('raw', Date.now() - t0, { raw: true });
    }

    const opts = humanOpts(args);
    const r = await human.humanDrag(page, a.exact, b.exact, {
      rng: opts.rng, button, modifiers, html5, fromW: human.fittsWidth(hitFrom.hit), toW: human.fittsWidth(hitTo.hit),
    });
    await human.sleep(human.thinkMs(opts));
    return out(html5 ? 'html5' : 'pointer', r.durationMs);
  },

  // Press / release a mouse button at the current pointer position. The hold
  // persists across commands (see `pages` -> input.held) until mouse-up / release.
  async 'mouse-down'(ctx, args) {
    const { page } = ctx;
    await needMouse(ctx, 'mouse-down');
    const button = parseButton(args.button);
    const opts = humanOpts(args);
    const st = human.inputState(page);
    if (st.buttons.has(button)) throw new Error(`the ${button} button is already held (mouse-up first, or release)`);
    const pos = await human.getPos(page, opts.rng);       // first use: a random on-screen point, like a resting hand
    let hit = null;
    if (st.buttons.size === 0) {
      hit = (await safeHit(page, pos.x, pos.y)).hit;
      st.html5 = !!(hit && hit.draggable);               // the moves while held must go through Playwright for an HTML5 drag
    }
    if (!isRaw(args)) await human.sleep(human.logNormal(opts.rng, 55, 0.3, 20, 180));
    await human.mouseDown(page, button, 1);
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { button, at: { x: round1(pos.x), y: round1(pos.y) }, hit, held: human.inputSnapshot(page).held };
  },

  async 'mouse-up'(ctx, args) {
    const { page } = ctx;
    await needMouse(ctx, 'mouse-up');
    const button = parseButton(args.button);
    const opts = humanOpts(args);
    const st = human.inputState(page);
    const wasHeld = st.buttons.has(button);
    if (wasHeld) {
      if (!isRaw(args)) await human.sleep(human.logNormal(opts.rng, 70, 0.3, 30, 180));
      await human.mouseUp(page, button, 1);
    }
    const pos = st.pos;
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { button, wasHeld, at: pos ? { x: round1(pos.x), y: round1(pos.y) } : null, held: human.inputSnapshot(page).held };
  },

  // Release every mouse button and key this page holds, in reverse order of pressing.
  async release(ctx) {
    const { released, errors } = await human.releaseAll(ctx.page);
    return {
      released, modifiers: 0, held: human.inputSnapshot(ctx.page).held,
      ...(errors.length ? { errors } : {}),
    };
  },

  async select(ctx, args) {
    const sel = requireSelector(args);
    if (args.value == null) throw new Error('value required');
    await needMouse(ctx, 'select');
    if (isRaw(args)) {
      const selected = await ctx.scope.selectOption(sel, args.value, { timeout: withTimeout(args) });
      return { selector: sel, selected, method: 'raw' };
    }
    return selectHuman(ctx, args, sel);
  },

  // Scroll with a quantised wheel (Windows notches by default, or the human's
  // own calibrated wheel: see `calibrate-wheel`). Acts on the scroll container
  // under the pointer: the inner panel of an SPA, a horizontal scroller, or
  // the document. Directions: up|down|left|right|top|bottom|<px>, or an
  // explicit horizontal --dx=<px>. Where the wheel happens:
  //   --target=<selector>   human-move the pointer into the element first
  //   --x=<n> --y=<n>       move the pointer to that viewport point first
  //   (neither)             at the current pointer, like a hand that stays put
  async scroll(ctx, args) {
    const { page } = ctx;
    await needMouse(ctx, 'scroll');
    const raw = isRaw(args);
    const opts = humanOpts(args);
    const rng = opts.rng;
    const dxArg = args.dx != null ? coords.parseNumber(args.dx === true ? '' : args.dx, '--dx') : null;
    const word = String(args.direction || args.where || (dxArg != null ? 'dx' : 'down'));

    let axis = 'y', amount = 0, toEdge = false;
    if (word === 'top') { toEdge = true; amount = -1; }
    else if (word === 'bottom') { toEdge = true; amount = 1; }
    else if (word === 'up') amount = -600;
    else if (word === 'down') amount = 600;
    else if (word === 'left' || word === 'right') {
      axis = 'x';
      const mag = dxArg != null ? Math.abs(dxArg) : 600;
      amount = word === 'left' ? -mag : mag;
    } else if (word === 'dx') { axis = 'x'; amount = dxArg; }
    else if (/^[+-]?\d+(\.\d+)?$/.test(word)) amount = parseFloat(word);
    else throw new Error(`bad scroll target: ${word}`);
    if (dxArg != null && !['left', 'right', 'dx'].includes(word)) {
      throw new Error('--dx is a horizontal amount: combine it with left/right (or use it alone); run a second scroll for the vertical part');
    }

    // where does the wheel act?
    const vp = await human.viewportMetrics(page);
    let point = null;
    if (args.target) {
      const loc = ctx.scope.locator(String(args.target));
      await loc.waitFor({ state: 'visible', timeout: opts.timeout });
      let box = await loc.boundingBox({ timeout: opts.timeout });
      const visible = (b) => {
        if (!b) return null;
        const x0 = Math.max(b.x, 0), y0 = Math.max(b.y, 0);
        const x1 = Math.min(b.x + b.width, vp.width), y1 = Math.min(b.y + b.height, vp.height);
        return x1 - x0 > 4 && y1 - y0 > 4 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
      };
      let vis = visible(box);
      if (!vis) { await human.resolveBox(loc, opts.timeout, { page: raw ? null : page, rng }); box = await loc.boundingBox({ timeout: opts.timeout }); vis = visible(box); }
      if (!vis) throw new Error(`--target ${args.target} has no visible area in the viewport (${vp.width}x${vp.height})`);
      point = human.pointInBox(vis, rng);
    } else if (args.x != null || args.y != null) {
      if (args.x == null || args.y == null) throw new Error('--x and --y go together');
      const pt = coords.resolvePoint(args.x, args.y, coords.parseSpace(args.space), vp, ['--x', '--y']);
      point = human.jitterPoint(pt.exact, rng, { x0: 0, y0: 0, x1: vp.width, y1: vp.height }, flag(args.exact), vp.dpr);
    }

    if (amount === 0 && !toEdge) return { scrolledBy: 0, axis, where: word };

    let r;
    if (raw) {
      const at = point || human.inputState(page).pos || { x: vp.width / 2, y: vp.height / 2 };
      r = await human.rawScroll(page, at, amount, { axis, toEdge });
    } else {
      if (point) await human.moveTo(page, point.x, point.y, { rng, targetW: 40 });
      r = await human.humanScroll(page, amount, { rng, axis, toEdge });
      await human.sleep(human.thinkMs(opts));
    }
    return {
      scrolledBy: round2(r.scrolled), axis, where: word, requested: r.requested,
      container: r.container, before: r.before, after: r.after,
      ...(raw ? {} : { events: r.events, wheelModel: r.wheelModel, quantum: r.quantum }),
      ...(r.scrollable === false ? { scrollable: false } : {}),
      ...(r.note ? { note: r.note } : {}),
    };
  },

  // Record the human's own wheel for a few seconds and store a calibration.
  async 'calibrate-wheel'(ctx, args) {
    return calibrateWheel(ctx, args);
  },

  // ---- touch (gated: refuses unless the page reports touch capability) -----

  async tap(ctx, args) {
    const sel = requireSelector(args);
    const { page } = ctx;
    const opts = humanOpts(args);
    await touch.assertTouchCapable(page, 1);
    const loc = ctx.scope.locator(sel);
    const box = await human.resolveBox(loc, opts.timeout, await scrollingOpts(ctx, args, opts.rng));
    const vp = await human.viewportMetrics(page);
    const extra = atOptions(args);
    const p = extra.at
      ? human.pointFromOffset(box, coords.resolveOffset(extra.at, extra.atSpace, vp, box), opts.rng, extra.exact, vp)
      : human.pointInBox(box, opts.rng);
    const r = await touch.tap(page, p.x, p.y, { rng: opts.rng, raw: isRaw(args) });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { selector: sel, ...r };
  },

  async 'tap-at'(ctx, args) {
    const { page } = ctx;
    const space = coords.parseSpace(args.space);
    const vp = await human.viewportMetrics(page);
    const pt = coords.resolvePoint(args.x, args.y, space, vp);
    await touch.assertTouchCapable(page, 1);
    const opts = humanOpts(args);
    const { hit } = await safeHit(page, pt.exact.x, pt.exact.y);
    const r = await touch.tap(page, pt.exact.x, pt.exact.y, { rng: opts.rng, raw: isRaw(args) });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { requested: pt.requested, css: pt.css, dpr: vp.dpr, hit, ...r };
  },

  async swipe(ctx, args) {
    const { page } = ctx;
    const space = coords.parseSpace(args.space);
    const vp = await human.viewportMetrics(page);
    const a = coords.resolvePoint(args.x1, args.y1, space, vp, ['x1', 'y1']);
    const b = coords.resolvePoint(args.x2, args.y2, space, vp, ['x2', 'y2']);
    await touch.assertTouchCapable(page, 1);
    const opts = humanOpts(args);
    const r = await touch.swipe(page, a.exact, b.exact, { rng: opts.rng, raw: isRaw(args) });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { from: { css: a.css, requested: a.requested }, to: { css: b.css, requested: b.requested }, durationMs: r.durationMs };
  },

  async pinch(ctx, args) {
    const { page } = ctx;
    const space = coords.parseSpace(args.space);
    const vp = await human.viewportMetrics(page);
    const c = coords.resolvePoint(args.x, args.y, space, vp);
    const scale = coords.parseNumber(args.scale === true ? '' : args.scale, '--scale');
    if (!(scale > 0.1 && scale < 10)) throw new Error(`bad --scale ${args.scale} (0.1..10; >1 spreads the fingers = zoom in, <1 pinches = zoom out)`);
    await touch.assertTouchCapable(page, 2);
    const opts = humanOpts(args);
    const r = await touch.pinch(page, c.exact.x, c.exact.y, scale, { rng: opts.rng, raw: isRaw(args), vp });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { center: c.css, requested: c.requested, ...r };
  },

  // ---- files ---------------------------------------------------------------

  async upload(ctx, args) {
    const sel = requireSelector(args);
    if (!args.path) throw new Error('path required');
    const abs = path.resolve(ctx.cwd || process.cwd(), args.path);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    await ctx.scope.setInputFiles(sel, abs, { timeout: withTimeout(args) });
    return { selector: sel, file: abs };
  },

  // Drop OS files onto an element as if dragged in from the file manager.
  async 'drop-files'(ctx, args) {
    const sel = requireSelector(args);
    const { page } = ctx;
    const raw = args.paths != null ? args.paths : args.path;
    const files = filedrop.resolveFiles(raw, ctx.cwd);
    const opts = humanOpts(args);
    const loc = ctx.scope.locator(sel);
    const box = await human.resolveBox(loc, opts.timeout, await scrollingOpts(ctx, args, opts.rng));
    const vp = await human.viewportMetrics(page);
    const extra = atOptions(args);
    const target = extra.at
      ? human.pointFromOffset(box, coords.resolveOffset(extra.at, extra.atSpace, vp, box), opts.rng, extra.exact, vp)
      : human.pointInBox(box, opts.rng);
    // an OS file drag is not pointer input, so it also works on a touch-only profile - but then no mouse is synced to the drop point
    const r = await filedrop.dropFiles(page, files, target, { rng: opts.rng, vp, raw: isRaw(args), mouse: await modality.hasFinePointer(page) });
    if (!isRaw(args)) await human.sleep(human.thinkMs(opts));
    return { selector: sel, files: files.map((f) => ({ name: f.name, size: f.size, path: f.path })), ...r };
  },

  // ---- waiting ------------------------------------------------------------

  async wait(ctx, args) {
    const ms = Number(args.ms);
    if (!Number.isFinite(ms) || ms < 0) throw new Error('ms required');
    await human.coarseSleep(ms);                  // a plain wait: no input event follows
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

  // Screenshot. The response carries what is needed to map image pixels back to
  // CSS pixels (see README "Coordinates, drag and keys"):
  //   dpr, viewport (CSS px), scroll, scale, imageSize (read from the PNG), clip
  //   (the CSS-px rectangle the image covers; the element box with --selector).
  //   --scale=device|css   device (default) = dpr pixels per CSS px; css = 1 per CSS px
  //   --selector=<sel>     screenshot just that element
  async shot(ctx, args) {
    const { page } = ctx;
    const scaleArg = args.scale == null ? 'device' : String(args.scale).toLowerCase();
    if (scaleArg !== 'device' && scaleArg !== 'css') throw new Error(`bad --scale '${args.scale}' (use device or css)`);
    const full = flag(args.fullPage);
    if (full && args.selector) throw new Error('--fullPage and --selector are mutually exclusive');
    const dir = artifactsDir(ctx.cwd);
    ensureDir(dir);
    const base = makeArtifactName(args.name);
    const file = path.join(dir, `${base}.png`);
    let clip = null;
    if (args.selector) {
      const loc = ctx.scope.locator(String(args.selector));
      await loc.screenshot({ path: file, scale: scaleArg, timeout: withTimeout(args) });
      clip = await loc.boundingBox({ timeout: 5000 }).catch(() => null);      // after the capture: the viewport it was taken in
    } else {
      await page.screenshot({ path: file, fullPage: full, scale: scaleArg });
    }
    const vp = await human.viewportMetrics(page);
    if (!clip) {
      if (full) {
        const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(() => null);
        clip = { x: -vp.scrollX, y: -vp.scrollY, width: doc ? doc.w : vp.width, height: doc ? doc.h : vp.height };
      } else clip = { x: 0, y: 0, width: vp.width, height: vp.height };
    }
    return {
      path: file, url: page.url(),
      dpr: vp.dpr,
      viewport: { width: vp.width, height: vp.height },
      scroll: { x: vp.scrollX, y: vp.scrollY },
      scale: scaleArg,
      imageSize: pngSize(file),
      clip: { x: round2(clip.x), y: round2(clip.y), width: round2(clip.width), height: round2(clip.height) },
    };
  },

  async 'save-artifact'(ctx, args) {
    const { page } = ctx;
    const dir = artifactsDir(ctx.cwd);
    ensureDir(dir);
    const base = makeArtifactName(args.name);
    const png  = path.join(dir, `${base}.png`);
    const html = path.join(dir, `${base}.html`);
    const meta = path.join(dir, `${base}.json`);
    await page.screenshot({ path: png, fullPage: flag(args.fullPage) });
    const content = await page.content();
    await fsp.writeFile(html, content, 'utf8');
    const info = {
      savedAt: new Date().toISOString(),
      page: ctx.rec.id,
      url: page.url(),
      title: await page.title().catch(() => null),
      viewport: await human.viewportMetrics(page),      // the REAL viewport: width, height, dpr, scrollX, scrollY
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

// ---------------------------------------------------------------------------
// helpers that need `commands` or are too long to inline
// ---------------------------------------------------------------------------

const MAX_PASTE_BYTES = 5 * 1024 * 1024;

/** The text to paste: positional <text> or --from-file=<path> (relative to the caller's cwd). */
function readPasteText(ctx, args) {
  const file = args['from-file'] != null ? args['from-file'] : args.fromFile;
  if (file != null && args.text != null) throw new Error('give the text OR --from-file, not both');
  if (file != null) {
    const abs = path.resolve(ctx.cwd || process.cwd(), String(file));
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`file not found: ${abs}`); }
    if (!st.isFile()) throw new Error(`not a file: ${abs}`);
    if (st.size > MAX_PASTE_BYTES) throw new Error(`file too large to paste (${st.size} bytes, limit ${MAX_PASTE_BYTES})`);
    return fs.readFileSync(abs, 'utf8');
  }
  if (args.text == null) throw new Error('text required (or --from-file=<path>)');
  return String(args.text);
}

/** Start the clipboard helper while the human click is still happening (PowerShell takes 1-2 s to start). */
function prewarmClipboard(ctx) {
  try {
    if (ctx.session && ctx.session.isHeadless && ctx.session.isHeadless()) return;
    clipboard.detectBackend().then((d) => { if (d.backend && d.backend.warm) d.backend.warm().catch(() => {}); }).catch(() => {});
  } catch { /* best effort */ }
}

// ---- native <select> --------------------------------------------------------

// Probe a <select>: its options (index, value, label, enabled) and current state.
function pageSelectProbe(el) {
  const win = el.ownerDocument.defaultView;
  const opts = Array.prototype.map.call(el.options, (o, i) => {
    const grp = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
    return {
      i, value: o.value, label: o.label || o.text,
      disabled: !!(o.disabled || (grp && grp.disabled)),
      hidden: !!(o.hidden || (grp && grp.hidden) || win.getComputedStyle(o).display === 'none'),
    };
  });
  return {
    tag: el.tagName.toLowerCase(), multiple: !!el.multiple, selectedIndex: el.selectedIndex,
    selected: Array.prototype.filter.call(el.options, (o) => o.selected).map((o) => o.value), options: opts,
  };
}

function parseWanted(value, multiple) {
  if (Array.isArray(value)) return value.map(String);
  const s = String(value);
  if (multiple) {
    const t = s.trim();
    if (t.startsWith('[')) { try { const a = JSON.parse(t); if (Array.isArray(a)) return a.map(String); } catch { /* not JSON */ } }
  }
  return [s];
}

function matchOption(options, w) {
  // Playwright matches an option by value OR label
  return options.find((o) => o.value === w) || options.find((o) => o.label === w) || null;
}

async function selectHuman(ctx, args, sel) {
  const { page } = ctx;
  const opts = humanOpts(args);
  const rng = opts.rng;
  const loc = ctx.scope.locator(sel);
  await loc.waitFor({ state: 'visible', timeout: opts.timeout });
  const info = await loc.evaluate(pageSelectProbe, undefined, { timeout: opts.timeout }).catch(() => null);
  const fallback = async (reason, method = 'fallback') => {
    const selected = await ctx.scope.selectOption(sel, args.value, { timeout: opts.timeout });
    return { selector: sel, selected, method, ...(reason ? { reason } : {}) };
  };
  if (!info || info.tag !== 'select') return fallback('not a native <select>');

  const wanted = parseWanted(args.value, info.multiple);
  const targets = wanted.map((w) => {
    const o = matchOption(info.options, w);
    if (!o) throw new Error(`no <option> matches '${w}' (values: ${info.options.map((x) => JSON.stringify(x.value)).join(', ')}; labels: ${info.options.map((x) => JSON.stringify(x.label)).join(', ')})`);
    if (o.disabled) throw new Error(`option '${w}' is disabled`);
    return o;
  });

  if (info.multiple) {
    // click the options themselves: a plain click on the first, Ctrl/Cmd-click for each additional one
    const modName = process.platform === 'darwin' ? 'Meta' : 'Control';
    const optLoc = loc.locator('option');
    for (let k = 0; k < targets.length; k++) {
      const handle = await optLoc.nth(targets[k].i).elementHandle({ timeout: opts.timeout });
      try {
        await handle.evaluate((o) => o.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        const r = await handle.evaluate((o) => { const b = o.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
        const vp = await human.viewportMetrics(page);
        const p = human.pointInBox(r, rng);
        await human.humanClickAt(page, p.x, p.y, {
          rng, exact: true, vp, targetW: Math.min(r.width, r.height),
          modifiers: k === 0 ? undefined : { names: [modName] },
        });
      } finally { await handle.dispose().catch(() => {}); }
      await human.sleep(human.logNormal(rng, 140, 0.3, 60, 380));
    }
    const after = await loc.evaluate(pageSelectProbe);
    const wantVals = new Set(targets.map((t) => t.value));
    const ok = after.selected.length === wantVals.size && after.selected.every((v) => wantVals.has(v));
    if (!ok) return fallback('selection did not match after clicking the options');
    await human.sleep(human.thinkMs(opts));
    return { selector: sel, selected: after.selected, method: 'click' };
  }

  // single select: open it with a real click, walk to the option with the arrow keys, commit with Enter
  const target = targets[0];
  if (target.i === info.selectedIndex) {
    return { selector: sel, selected: info.selected, method: 'unchanged' };
  }
  const usable = (o) => !o.disabled && !o.hidden;
  const from = info.selectedIndex, to = target.i;
  let steps = 0;
  const dir = to > from ? 1 : -1;
  for (let i = from + dir; dir > 0 ? i <= to : i >= to; i += dir) if (usable(info.options[i])) steps += 1;
  if (steps > 40) return fallback(`${steps} arrow steps away: too far to walk by keyboard`);

  await human.humanClick(page, loc, opts);                          // opens the list (headed) / focuses it
  await human.sleep(human.logNormal(rng, 170, 0.35, 70, 450));       // look at the list
  const key = dir > 0 ? 'ArrowDown' : 'ArrowUp';
  for (let k = 0; k < steps; k++) {
    await human.humanPress(page, key, { rng });
    await human.sleep(human.logNormal(rng, 110, 0.3, 55, 280));
  }
  await human.sleep(human.logNormal(rng, 130, 0.35, 60, 380));
  await human.humanPress(page, 'Enter', { rng });
  await human.coarseSleep(150);                                       // let the page settle before reading it back (no input follows)
  const after = await loc.evaluate(pageSelectProbe).catch(() => null);
  if (after && after.selectedIndex === to) {
    await human.sleep(human.thinkMs(opts));
    return { selector: sel, selected: after.selected, method: 'keyboard', steps };
  }
  await human.humanPress(page, 'Escape', { rng }).catch(() => {});    // make sure no list is left open
  return fallback('keyboard selection did not take effect');
}

// ---- calibrate-wheel ----------------------------------------------------------

/**
 * calibrate-wheel draws an overlay (a DOM element, visible to the site's own scripts) and records the wheel with page
 * listeners, so it must not run on a real website: only about:blank, a data: or file: URL, or a page served from this
 * machine (http(s) on localhost, 127.0.0.1 or [::1]) qualifies.
 */
function calibratablePage(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'about:') return u.pathname === 'blank';
  if (u.protocol === 'data:' || u.protocol === 'file:') return true;
  if (u.protocol === 'http:' || u.protocol === 'https:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return false;
}

async function calibrateWheel(ctx, args) {
  const { page } = ctx;
  const here = page.url();
  if (!calibratablePage(here)) {
    let shown = here;
    try { const u = new URL(here); shown = u.protocol.startsWith('http') ? u.origin : u.protocol; } catch { /* show it as it is */ }
    throw new Error(
      `calibrate-wheel refused on ${shown}: it puts a visible overlay (a DOM element) on the page and records the wheel with page listeners, ` +
      'both of which that site\'s own scripts can see. Calibrate on a blank page instead: open one with ' +
      '`nativewright new --label=calibrate` (it starts on about:blank), then run `nativewright calibrate-wheel --page=<id>`. ' +
      'Allowed pages: about:blank, data: and file: URLs, and http(s) on localhost / 127.0.0.1 / [::1].');
  }
  const seconds = args.seconds != null ? Number(args.seconds) : 10;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) throw new Error('bad --seconds (1..300)');
  const simulate = flag(args.simulate);
  if (simulate) await needMouse(ctx, 'calibrate-wheel --simulate');       // the self-test dispatches a mouse wheel
  const existing = wheel.loadProfile();
  if (simulate && existing && existing.source === 'human' && !flag(args.force)) {
    throw new Error('refusing to overwrite a HUMAN wheel calibration with a simulated one (pass --force to do it anyway)');
  }
  const opts = humanOpts(args);
  await page.bringToFront().catch(() => {});

  // overlay + recorder, in the isolated world (event listeners there see the page's trusted wheel events)
  await page.evaluate((secs) => {
    const old = document.getElementById('__nw_wheel_overlay');
    if (old) old.remove();
    if (window.__nw_wheel_off) window.__nw_wheel_off();
    const ov = document.createElement('div');
    ov.id = '__nw_wheel_overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(15,23,42,.55);color:#fff;font:600 28px/1.35 system-ui,sans-serif;text-align:center;padding:24px';
    ov.innerHTML = '<div>NativeWright wheel calibration<br><span style="font-weight:400;font-size:20px">Scroll with your own mouse wheel for <b id="__nw_wheel_left">' + secs +
      '</b> s, in your normal rhythm: short flicks, then pauses.<br>Events recorded: <b id="__nw_wheel_n">0</b></span></div>';
    document.documentElement.appendChild(ov);
    const rec = [];
    const h = (e) => { rec.push({ t: e.timeStamp, dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, trusted: e.isTrusted }); };
    window.addEventListener('wheel', h, { capture: true, passive: true });
    window.__nw_wheel = rec;
    window.__nw_wheel_off = () => { window.removeEventListener('wheel', h, true); ov.remove(); };
  }, seconds);

  const started = Date.now();
  let feeder = null;
  if (simulate) {
    // self-test: feed the recorder through the real input path (trusted CDP wheel events)
    feeder = (async () => {
      const vp = await human.viewportMetrics(page);
      await human.moveTo(page, vp.width * 0.5, vp.height * 0.5, { rng: opts.rng, targetW: 40 });
      const player = wheel.makePlayer(wheel.DEFAULT_MODEL, opts.rng, { logNormal: human.logNormal, gaussian: human.gaussian });
      let n = 0;
      while (Date.now() - started < seconds * 1000 - 400 && n < 400) {
        const ev = player.next();
        await page.mouse.wheel(0, ev.delta);
        n += 1;
        await human.sleep(ev.gapMs);
      }
    })().catch(() => {});
  }
  try {
    while (Date.now() - started < seconds * 1000) {
      await human.coarseSleep(400);                        // refreshing the overlay: no input event follows
      const left = Math.max(0, Math.ceil(seconds - (Date.now() - started) / 1000));
      await page.evaluate((l) => {
        const a = document.getElementById('__nw_wheel_left'), b = document.getElementById('__nw_wheel_n');
        if (a) a.textContent = String(l);
        if (b && window.__nw_wheel) b.textContent = String(window.__nw_wheel.length);
      }, left).catch(() => {});
    }
  } finally {
    if (feeder) await feeder;
  }
  const dump = await page.evaluate(() => {
    const out = window.__nw_wheel || [];
    if (window.__nw_wheel_off) window.__nw_wheel_off();
    delete window.__nw_wheel; delete window.__nw_wheel_off;
    return out;
  }).catch(() => []);
  const trusted = dump.filter((e) => e.trusted);
  const vp = await human.viewportMetrics(page);
  const profile = wheel.deriveProfile(trusted, { source: simulate ? 'simulated' : 'human', dpr: vp.dpr });   // throws when < 20 events
  const file = wheel.saveProfile(profile);
  const active = wheel.calibrationStatus();
  return {
    saved: file, source: profile.source, events: profile.events, ignoredUntrusted: dump.length - trusted.length,
    quantum: profile.quantum, quantised: profile.quantised, deltas: profile.deltas,
    bursts: profile.bursts, burstLen: profile.burstLen, intraGapMs: profile.intraGap, interGapMs: profile.interGap,
    replaced: !!existing,
    // which wheel model scrolling uses from now on: 'human' (this calibration) or 'default'
    activeModel: active.model,
    ...(profile.source === 'human' ? {} : { note: 'a simulated profile is a self-test artefact: it is saved but NOT used for scrolling (only a human calibration is adopted)' }),
  };
}

module.exports = { commands, PAGELESS, _calibratablePage: calibratablePage };      // (the last one is exported for tests)
