'use strict';

// Human-behavior primitives used by the daemon to make every mouse / keyboard
// action look like a real person. Applied by default to click/type/hover/fill/
// scroll/press/drag/... — callers opt out with raw:true when they truly need
// robotic precision (e.g. invisible elements, programmatic fills).
//
// Design:
//  - All randomness flows through a single PRNG (Math.random by default; a
//    seeded mulberry32 if a seed is provided). This means nothing in here
//    reaches for `Math.random` directly — pass `rng()` everywhere.
//  - All timing distributions are log-normal, not uniform. Real human
//    key-press intervals and think-times are heavy-tailed.
//  - Mouse paths are cubic Bézier with perpendicular control-point offsets
//    plus per-sample Gaussian jitter. Time along the path follows an
//    ease-in-out curve (slow start, fast middle, slow arrival).
//  - Never moves to the dead center of a bbox. Lands somewhere inside with
//    a truncated Gaussian around the center.
//  - Per-page INPUT STATE (pointer position, held buttons/keys, modifier mask,
//    keyboard layout) lives in a WeakMap keyed on the Page, so holds persist
//    across commands, raw-CDP pointer bursts carry the same buttons/modifiers
//    Playwright's own mouse would, and `release` can undo everything.

const layouts = require('./layouts');
const K = require('./keys');
const wheel = require('./wheel');
const inspect = require('./inspect');
const coords = require('./coords');
const timing = require('./timing');

// --------------------------------------------------------------------------
// RNG
// --------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  if (seed == null) return Math.random;
  const n = Number(seed);
  if (!Number.isFinite(n)) return Math.random;
  return mulberry32(Math.trunc(n));
}

// Standard Normal via Box–Muller (rejecting the 0-case).
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Log-normal sample with a clamp to avoid absurd tails on UI actions.
function logNormal(rng, meanMs, sigma = 0.35, minMs = 10, maxMs = 5000) {
  const mu = Math.log(meanMs);
  const x = Math.exp(mu + sigma * gaussian(rng));
  return Math.max(minMs, Math.min(maxMs, x));
}

/**
 * Sleep `ms` with sub-millisecond accuracy (see ./timing.js: Node's own timer lands on the OS tick, 15.6 ms on
 * Windows, and every dwell and gap the page observed was a multiple of it). Use for EVERY wait that is followed by an
 * input event: settle, dwell, lead/lag, typing delays, wheel gaps, frame pacing, think times.
 */
const sleep = timing.preciseSleep;

/**
 * Plain setTimeout, for internal polling that does not end in an input event (waiting on page state, overlay refresh,
 * a verify loop). It rounds up to the timer tick, which is fine there.
 */
const coarseSleep = timing.coarseSleep;

/** Sleep until an absolute epoch-ms deadline (no drift accumulation), precisely. Kept for callers that think in epoch ms. */
function sleepUntil(epochMs) {
  return timing.preciseSleepUntil(timing.now() + (epochMs - Date.now()));
}

// --------------------------------------------------------------------------
// Geometry
// --------------------------------------------------------------------------

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Cubic Bézier point at t ∈ [0,1].
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u, uuu = uu * u;
  const tt = t * t, ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

// Build control points perpendicular to the direct line from→to, offset
// proportional to distance with Gaussian noise. This gives the mouse a
// natural curve instead of a straight line.
function buildControlPoints(from, to, rng) {
  const d = dist(from, to);
  if (d < 1) return { p1: from, p2: to };

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  const dx = to.x - from.x, dy = to.y - from.y;
  // unit perpendicular vector
  const nx = -dy / d, ny = dx / d;

  // two control points at ~1/3 and ~2/3 of the line, pushed off-axis
  const offsetA = (gaussian(rng) * 0.15 + (rng() - 0.5) * 0.25) * d;
  const offsetB = (gaussian(rng) * 0.15 + (rng() - 0.5) * 0.25) * d;

  const p1 = {
    x: from.x + dx / 3 + nx * offsetA + (rng() - 0.5) * 6,
    y: from.y + dy / 3 + ny * offsetA + (rng() - 0.5) * 6,
  };
  const p2 = {
    x: from.x + (2 * dx) / 3 + nx * offsetB + (rng() - 0.5) * 6,
    y: from.y + (2 * dy) / 3 + ny * offsetB + (rng() - 0.5) * 6,
  };
  return { p1, p2 };
}

// Family of easing functions. Real human pointing uses different speed
// profiles depending on confidence and distance: ease-in-out for deliberate
// moves, asymmetric ease-out for short flicks, near-linear for "dragged"
// mouse paths. We pick one per call so a detector can't fingerprint a
// single velocity profile.
function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOut(t) { return 1 - Math.pow(1 - t, 2.5); }
function easeLinearish(t) {
  // near-linear with a mild S bend — sampled closer to a constant-velocity move
  return 0.85 * t + 0.15 * (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
}
function pickEasing(rng) {
  const r = rng();
  if (r < 0.55) return easeInOut;
  if (r < 0.85) return easeOut;
  return easeLinearish;
}

// Sample the Bézier path into N steps with a randomly-chosen easing plus
// jitter. Occasionally inserts a mid-path "hesitation" where the mouse
// briefly slows and wobbles — real users do this when the target is
// non-obvious or the cursor is on the wrong line.
function samplePath(from, to, rng, opts = {}) {
  const d = dist(from, to);
  const steps = Math.max(8, Math.min(80, Math.round(d / 14 + 6)));
  const { p1, p2 } = buildControlPoints(from, to, rng);
  const easing = opts.easing || pickEasing(rng);

  // 12% chance of a mid-path hesitation (only for moves > 80px)
  const hesitate = d > 80 && rng() < 0.12
    ? { atT: 0.35 + rng() * 0.3, extraSamples: 3 + Math.floor(rng() * 4) }
    : null;

  const path = [];
  for (let i = 1; i <= steps; i++) {
    const tLinear = i / steps;
    const t = easing(tLinear);
    const pt = bezier(from, p1, p2, to, t);
    const jitter = 1.2 * (1 - tLinear) + 0.2;
    pt.x += gaussian(rng) * jitter;
    pt.y += gaussian(rng) * jitter;
    pt.pauseMs = 0;
    path.push(pt);

    if (hesitate && tLinear >= hesitate.atT && !hesitate.done) {
      hesitate.done = true;
      // append a few near-stationary jitter samples before resuming
      for (let j = 0; j < hesitate.extraSamples; j++) {
        const last = path[path.length - 1];
        path.push({
          x: last.x + gaussian(rng) * 1.5,
          y: last.y + gaussian(rng) * 1.5,
          pauseMs: 40 + rng() * 90,
        });
      }
    }
  }
  path[path.length - 1] = { x: to.x, y: to.y, pauseMs: 0 };
  return { path, steps };
}

// Fitts-like total duration for a move of distance `d` to a target of
// effective width `w`. Real human pointing is ~150ms for easy targets and
// grows log-linearly with d/w. Tuned to feel natural at 1080p.
function moveDurationMs(d, w, rng) {
  const a = 80, b = 90;
  const width = Math.max(8, w || 20);
  const idx = Math.log2(d / width + 1);
  const mean = a + b * idx;
  return logNormal(rng, mean, 0.22, 40, 1400);
}

// --------------------------------------------------------------------------
// Per-page input state
// --------------------------------------------------------------------------

const BUTTON_BIT = { left: 1, right: 2, middle: 4 };
const INPUT = new WeakMap();

/**
 * The input state of a page. Created on first use.
 *   pos        {x,y} CSS px — where the pointer is, or null until it was placed
 *   buttons    Set of held mouse buttons
 *   keys       Set of held keys (canonical names; modifiers included)
 *   modifiers  Alt=1 Control=2 Meta=4 Shift=8 (what is logically held)
 *   layout     active keyboard layout ('en' | 'ru')
 * plus bookkeeping: lastButton (mirrors Playwright's Mouse), order (press
 * order, for reverse release), synced (does Playwright's mouse know `pos`),
 * html5 (the held button started an HTML5 drag: moves must use Playwright's mouse),
 * dpr (the page's devicePixelRatio when last measured: every pointer coordinate
 * is snapped to that device-pixel grid, see q()).
 */
function inputState(page) {
  let s = INPUT.get(page);
  if (!s) {
    s = {
      pos: null,
      buttons: new Set(),
      keys: new Set(),
      keyDescs: new Map(),
      modifiers: 0,
      lastButton: 'none',
      order: [],
      synced: false,
      html5: false,
      layout: 'en',
      dpr: null,
      lastTs: null,               // the event-clock stamp (s) of the last coalesced sub-sample sent: the next burst never goes back before it
    };
    INPUT.set(page, s);
  }
  return s;
}

// --------------------------------------------------------------------------
// The device-pixel grid
//
// A real mouse reports PHYSICAL pixels, so the page sees integer coordinates at
// devicePixelRatio 1 and multiples of 1/dpr at any other ratio. Playwright passes
// whatever float it is given straight through (measured: mouse.down at (120.43,
// 60.29) -> PointerEvent.clientX 120.43000030517578; 16 of 569 pointer coordinates
// of a click grid were fractional), and a burst sub-sample rounded to a whole CSS
// pixel is off the grid at dpr 1.5 (101 css px = 151.5 device px, unreachable).
// So every pointer coordinate the daemon dispatches goes through q(). Touch is
// the exception: a digitizer reports sub-pixel positions.
// --------------------------------------------------------------------------

/** Snap a CSS-pixel coordinate to the device-pixel grid: round(v * dpr) / dpr (an unknown dpr counts as 1). */
function q(v, dpr) {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.round(v * d) / d;
}

/** The dpr noted for this page (1 until a viewport was measured). */
function dprOf(page) {
  const st = INPUT.get(page);
  return st && st.dpr > 0 ? st.dpr : 1;
}

/** Remember the page's devicePixelRatio (ignored when it is not a positive number). */
function noteDpr(page, dpr) {
  if (Number.isFinite(dpr) && dpr > 0) inputState(page).dpr = dpr;
}

/** A point snapped to the page's device-pixel grid. */
function snapPoint(page, p) {
  const d = dprOf(page);
  return { x: q(p.x, d), y: q(p.y, d) };
}

/** Read-only view for `pages` / `state`: where the pointer is and what is still held. */
function inputSnapshot(page) {
  const st = INPUT.get(page);
  if (!st) return { pointer: null, held: { buttons: [], keys: [] }, layout: 'en' };
  const r1 = (n) => Math.round(n * 10) / 10;
  return {
    pointer: st.pos ? { x: r1(st.pos.x), y: r1(st.pos.y) } : null,
    held: { buttons: [...st.buttons], keys: [...st.keys] },
    layout: st.layout,
  };
}

function buttonsMask(set) {
  let m = 0;
  for (const b of set) m |= BUTTON_BIT[b] || 0;
  return m;
}

function track(st, kind, name) { st.order.push({ kind, name }); }
function untrack(st, kind, name) {
  for (let i = st.order.length - 1; i >= 0; i--) {
    if (st.order[i].kind === kind && st.order[i].name === name) { st.order.splice(i, 1); return; }
  }
}

/**
 * The REAL viewport, measured fresh on every call (windows can be resized).
 * `page.viewportSize()` is null here because the context is launched with
 * `viewport: null`, which used to make everything fall back to 1280x800 while
 * the actual window was 758x482 (headless) / ~1180x730 (agent windows).
 * Falls back to an estimate only if the evaluate itself fails (page navigating).
 */
async function viewportMetrics(page) {
  try {
    const m = await page.evaluate(() => ({
      width: window.innerWidth, height: window.innerHeight,
      dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY,
    }));
    if (m && Number.isFinite(m.width) && Number.isFinite(m.height)) {
      noteDpr(page, m.dpr);                              // the pointer grid follows the page's current devicePixelRatio
      return m;
    }
  } catch { /* fall through to the estimate */ }
  const vs = page.viewportSize();
  return {
    width: vs ? vs.width : 1280, height: vs ? vs.height : 800,
    dpr: 1, scrollX: 0, scrollY: 0, estimated: true,
  };
}

// Track the mouse's logical position because Playwright's mouse object is
// stateless between moves. The first move of a daemon lifetime starts from
// a random on-screen point (not 0,0, which is bot-telltale) inside the REAL
// viewport.
async function getPos(page, rng) {
  const st = inputState(page);
  if (st.pos) return st.pos;
  const r = rng || Math.random;
  const vp = await viewportMetrics(page);
  const d = vp.dpr;
  st.pos = {
    x: q(Math.round(vp.width * (0.2 + 0.6 * r())), d),
    y: q(Math.round(vp.height * (0.2 + 0.6 * r())), d),
  };
  st.synced = false;
  return st.pos;
}

/** Record where the pointer is (snapped to the device-pixel grid, like everything the daemon dispatches). */
function setPos(page, p) {
  inputState(page).pos = snapPoint(page, p);
}

/** Make Playwright's own Mouse aware of the tracked pointer position (a harmless move sample). */
async function syncPointer(page) {
  const st = inputState(page);
  if (st.pos && !st.synced) {
    await page.mouse.move(st.pos.x, st.pos.y, { steps: 1 });
    st.synced = true;
  }
}

/**
 * The raw (--raw) coordinate commands' straight move from `from` to `to` in `steps` Playwright moves, every step on the
 * device-pixel grid (Playwright's own `steps` interpolation is fractional). The pointer state follows.
 */
async function rawMove(page, from, to, steps = 1) {
  const d = dprOf(page);
  const n = Math.max(1, Math.floor(steps));
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    await page.mouse.move(q(from.x + (to.x - from.x) * f, d), q(from.y + (to.y - from.y) * f, d), { steps: 1 });
  }
  setPos(page, to);
  inputState(page).synced = true;
}

// --- CDP-backed coalesced pointer dispatch ---------------------------------
// Real mice poll at 125-1000Hz while displays refresh at 60-144Hz, so Chromium
// coalesces several raw samples into each dispatched `pointermove`;
// `PointerEvent.getCoalescedEvents()` then returns those sub-samples. A path
// driven by one *awaited* `page.mouse.move` per point produces exactly ONE
// coalesced sub-event every time — a well-known synthetic-input signature —
// because each awaited dispatch fully round-trips before the next is sent.
// (Empirically verified: awaited Playwright OR awaited raw CDP both yield
// length 1; only un-awaited bursts coalesce.)
//
// We reproduce real coalescing by dispatching each display-frame of motion as
// a BURST of sub-samples fired WITHOUT awaiting between them (so they reach the
// renderer inside one frame and coalesce), each carrying an explicit,
// monotonically-increasing CDP `timestamp` (so the coalesced sub-events have
// realistic distinct `timeStamp`s: a real mouse polls 125-1000 Hz, far finer
// than a display frame). These sub-samples are the ONLY events that carry an
// explicit timestamp; they come from timing.nowSec(), a monotonic clock pinned
// to the browser's own, and every discrete event (click, key, wheel, touch) is
// left for Chrome to stamp at dispatch, like real input.
// This needs a CDP session; if one can't be created we fall back to the
// classic per-point awaited dispatch (functionally correct, coalesced len 1).
const CDP_SESSIONS = new WeakMap();
async function getCdpSession(page) {
  const cached = CDP_SESSIONS.get(page);
  if (cached !== undefined) return cached;       // cache null too — don't retry
  let s = null;
  try { s = await page.context().newCDPSession(page); } catch { s = null; }
  CDP_SESSIONS.set(page, s);
  return s;
}

// Dispatch one display-frame of motion: K sub-samples interpolated from `prev`
// to `p`, fired un-awaited so Chromium coalesces them into a single
// `pointermove`. K scales with segment length (faster motion → more coalesced
// samples, like real hardware). Sub-sample timestamps come from the monotonic
// event clock (timing.nowSec()), spaced by the simulated polling interval, the
// last one = now and none later, so the page never sees an event dated in the
// future. Sub-sample positions are on the device-pixel grid (q()).
//
// Every sample carries the page's current input state — `buttons` (pressed
// mask), `button` (the last pressed button, else 'none') and `modifiers` —
// exactly as patchright's own mouse would stamp them (server/chromium/crInput.js),
// so a drag's event stream stays consistent with the Playwright-dispatched
// mousedown/mouseup around it.
async function dispatchFrameBurst(cdp, st, prev, p, frameDurMs, rng) {
  const segLen = dist(prev, p);
  let k = Math.max(1, Math.min(7, Math.round(segLen / 5)));
  if (k > 2 && rng() < 0.3) k -= 1;              // jitter count; keep slow segs low
  const now = timing.nowSec();
  // The sub-samples span (k-1) polling intervals ending at `now`, but never reach back before the previous burst's last
  // sample (a real mouse's timestamps only go forward, also from one pointermove to the next): when the frame is
  // shorter than that, the span shrinks and so does k (>= 0.1 ms between samples).
  let span = (k - 1) * (frameDurMs / k) / 1000;
  if (st.lastTs != null) span = Math.min(span, Math.max(0, now - st.lastTs - 5e-5));
  k = Math.max(1, Math.min(k, Math.floor(span / 1e-4) + 1));
  const step = k > 1 ? span / (k - 1) : 0;
  const buttons = buttonsMask(st.buttons);
  const dpr = st.dpr;
  const subs = [];
  for (let j = 0; j < k; j++) {
    const f = (j + 1) / k;
    subs.push({
      x: q(prev.x + (p.x - prev.x) * f, dpr),
      y: q(prev.y + (p.y - prev.y) * f, dpr),
      ts: j === k - 1 ? now : now - (k - 1 - j) * step,     // strictly increasing; the last = now, none later
    });
  }
  st.lastTs = now;
  const base = { type: 'mouseMoved', button: buttons ? st.lastButton : 'none', buttons, modifiers: st.modifiers };
  if (buttons) base.force = 0.5;                 // pressure of a held mouse button, like Playwright's moves
  await Promise.all(subs.map((s) => cdp.send('Input.dispatchMouseEvent', {
    ...base, x: s.x, y: s.y, timestamp: s.ts,
  })));
}

// Walk a sampled path: one dispatched `pointermove` per point, sleeping
// `perStepMs` (jittered) between points. Uses coalesced CDP bursts when a
// session is given, else classic awaited single moves through Playwright's
// mouse (which an HTML5 drag requires: patchright only intercepts drags
// caused by its own mouse). Returns final pos.
async function traversePath(page, cdp, fromPoint, path, perStepMs, rng) {
  const st = inputState(page);
  let prev = { x: fromPoint.x, y: fromPoint.y };
  for (let i = 0; i < path.length; i++) {
    const p = { x: q(path[i].x, st.dpr), y: q(path[i].y, st.dpr), pauseMs: path[i].pauseMs };     // on the device-pixel grid
    const frameDur = perStepMs * (1 + (rng() - 0.5) * 0.5);
    const t0 = timing.now();
    if (cdp) {
      try { await dispatchFrameBurst(cdp, st, prev, p, frameDur, rng); }
      catch { await page.mouse.move(p.x, p.y, { steps: 1 }); }
    } else {
      await page.mouse.move(p.x, p.y, { steps: 1 });
    }
    // Pace on an absolute schedule: the dispatch itself (a CDP / Playwright round trip) counts against the frame.
    // Hesitation samples carry their own extra pause; the others use the frame time.
    await timing.preciseSleepUntil(t0 + (p.pauseMs || 0) + frameDur);
    prev = { x: p.x, y: p.y };
    st.pos = { x: p.x, y: p.y };
  }
  return prev;
}

// Move the mouse along a natural path to (x,y). `targetW` is the effective
// size of the target (used for Fitts timing); pass the bbox width when
// moving toward an element.
//   opts.noOvershoot     never overshoot-and-correct (drags)
//   opts.durationScale   stretch the Fitts duration (drags are ~1.4x slower)
//   opts.viaPlaywright   force moves through Playwright's mouse
async function moveTo(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  const st = inputState(page);
  if (!(st.dpr > 0)) await viewportMetrics(page);             // the grid needs the dpr before the first coordinate
  const from = await getPos(page, rng);
  const to = { x: q(x, st.dpr), y: q(y, st.dpr) };           // everything dispatched sits on the device-pixel grid
  const d = dist(from, to);

  // While a button that started an HTML5 drag is held, EVERY move must go
  // through Playwright's mouse: its DragManager only intercepts drags caused
  // by its own moves. Raw CDP moves would start a native OS drag that
  // delivers no dragenter/dragover/drop (verified empirically).
  const viaPw = !!opts.viaPlaywright || (st.buttons.size > 0 && st.html5);

  // Even when already at (or near) target, emit a small idle jitter so
  // repeat-clicks don't produce an empty-move signature. Cheap and cheap
  // to skip in raw mode (callers don't call moveTo there).
  if (d < 2) {
    const j = 1 + rng() * 3;
    const ang = rng() * Math.PI * 2;
    const jitterTo = { x: q(from.x + Math.cos(ang) * j, st.dpr), y: q(from.y + Math.sin(ang) * j, st.dpr) };
    await page.mouse.move(jitterTo.x, jitterTo.y, { steps: 1 });
    await sleep(20 + rng() * 40);
    await page.mouse.move(to.x, to.y, { steps: 1 });
    setPos(page, to);
    st.synced = true;
    return;
  }

  const cdp = viaPw ? null : await getCdpSession(page);
  let durationMs = moveDurationMs(d, opts.targetW || 20, rng);
  if (opts.durationScale) durationMs *= opts.durationScale;

  // Optional overshoot: for longer moves, ~20% chance to overshoot the
  // target slightly then correct back. Never overshoot tiny targets.
  const doOvershoot = !opts.noOvershoot && d > 120 && opts.targetW > 12 && rng() < 0.2;
  let primaryTarget = to;
  let overshootPoint = null;
  if (doOvershoot) {
    const overshootMag = 6 + rng() * 18;
    const dx = (to.x - from.x) / d, dy = (to.y - from.y) / d;
    overshootPoint = {
      x: q(to.x + dx * overshootMag + (rng() - 0.5) * 4, st.dpr),
      y: q(to.y + dy * overshootMag + (rng() - 0.5) * 4, st.dpr),
    };
    primaryTarget = overshootPoint;
  }

  const { path, steps } = samplePath(from, primaryTarget, rng);
  st.synced = false;                              // raw bursts bypass Playwright's own mouse position
  await traversePath(page, cdp, from, path, durationMs / steps, rng);

  if (overshootPoint) {
    setPos(page, overshootPoint);
    const { path: corr } = samplePath(overshootPoint, to, rng, { easing: easeOut });
    const corrDur = logNormal(rng, 90, 0.25, 60, 220);
    await traversePath(page, cdp, overshootPoint, corr, corrDur / corr.length, rng);
  }

  // Sync Playwright's own mouse position to the final target: the CDP burst
  // path bypasses Playwright's internal mouse state, so a subsequent
  // page.mouse.down()/up() (the click) must be re-anchored here or it would
  // fire at a stale coordinate. The cursor is already at `to` (CDP moved it),
  // so this trailing move dispatches a harmless final settle sample.
  if (cdp) { try { await page.mouse.move(to.x, to.y, { steps: 1 }); } catch { /* ignore */ } }
  st.synced = true;
  setPos(page, to);
}

// --------------------------------------------------------------------------
// Held inputs: mouse buttons and modifier keys
//
// Buttons go through Playwright's page.mouse.down/up (keeps its own Mouse and
// DragManager state coherent) and are mirrored into the page's input state.
// Modifier keys go through page.keyboard.down/up, so Playwright stamps them
// onto its own mouse events, and are mirrored into state.modifiers.
// --------------------------------------------------------------------------

async function mouseDown(page, button = 'left', clickCount = 1) {
  const st = inputState(page);
  // a physical button cannot be pressed twice: a click needs it UP first
  if (st.buttons.has(button)) {
    throw new Error(`the ${button} mouse button is already held on this page (mouse-up it first, or run \`release\`)`);
  }
  await syncPointer(page);
  st.buttons.add(button);
  st.lastButton = button;                          // mirrors Playwright's Mouse.down
  track(st, 'button', button);
  await page.mouse.down({ button, clickCount });
}

async function mouseUp(page, button = 'left', clickCount = 1) {
  const st = inputState(page);
  try { await page.mouse.up({ button, clickCount }); }
  finally {
    st.buttons.delete(button);
    st.lastButton = 'none';                        // mirrors Playwright's Mouse.up
    untrack(st, 'button', button);
    if (st.buttons.size === 0) st.html5 = false;
  }
}

/** Press a modifier (Shift/Control/Alt/Meta). Resolves false if it was already held (nothing pressed). */
async function pressModifier(page, name) {
  const st = inputState(page);
  if (st.keys.has(name)) return false;
  st.keys.add(name);
  st.modifiers |= K.MOD_BITS[name];
  track(st, 'key', name);
  try { await page.keyboard.down(name); }
  catch (e) {
    st.keys.delete(name); st.modifiers &= ~K.MOD_BITS[name]; untrack(st, 'key', name);
    throw e;
  }
  return true;
}

async function releaseModifier(page, name) {
  const st = inputState(page);
  try { await page.keyboard.up(name); }
  finally {
    st.keys.delete(name);
    st.modifiers &= ~K.MOD_BITS[name];
    untrack(st, 'key', name);
  }
}

/** Run an async cleanup, swallowing its errors (used in `finally` blocks). */
async function quietly(fn) { try { await fn(); } catch { /* best effort */ } }

// --------------------------------------------------------------------------
// Landing points
// --------------------------------------------------------------------------

// Pick a point inside the bbox. For roughly-square targets we use a
// Gaussian around the center. For wide elements (buttons, nav links with
// text), we widen the X distribution so clicks land across the element
// proportionally — approximating where the visible label text is rather
// than always dead-center.
function pointInBox(box, rng) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Aspect-aware σ: for wide elements use closer-to-uniform along the long
  // axis (σ scales up). For ~square elements stay Gaussian.
  const aspect = box.width / Math.max(1, box.height);
  const sigmaXFrac = Math.min(0.45, 0.2 + Math.max(0, Math.log2(aspect)) * 0.08);
  const sigmaYFrac = 0.22;

  const sx = box.width * sigmaXFrac;
  const sy = box.height * sigmaYFrac;
  let x = cx + gaussian(rng) * sx;
  let y = cy + gaussian(rng) * sy;
  // keep a small margin from the edges (bigger margin on tall elements)
  const mx = Math.min(6, Math.max(2, box.width * 0.04));
  const my = Math.min(6, Math.max(2, box.height * 0.1));
  x = Math.min(box.x + box.width - mx, Math.max(box.x + mx, x));
  y = Math.min(box.y + box.height - my, Math.max(box.y + my, y));
  return { x, y };
}

// The bottom-right corner of a resizable element (a <textarea>'s grip is ~15 px; 18 with a margin).
const RESIZE_GRIP_PX = 18;
const inResizeGrip = (box, p) => p.x > box.x + box.width - RESIZE_GRIP_PX && p.y > box.y + box.height - RESIZE_GRIP_PX;
function pageIsResizable(el) {
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  return cs.resize !== 'none' && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible');
}

/**
 * A click point that is not in the resize grip. pointInBox is a Gaussian around the middle clamped to a 2-6 px margin, so on a
 * wide <textarea> the clamp piles mass onto the right edge and ~1 click in 80 landed on the grip (measured: the press starts a
 * resize drag and the field never gets the focus, so the text that follows is typed into nothing). Only a resizable element
 * is checked, and only when the point is in its corner: a point elsewhere costs nothing.
 */
async function avoidResizeGrip(locator, box, point, rng, timeout) {
  if (!inResizeGrip(box, point)) return point;
  const resizable = await locator.evaluate(pageIsResizable, undefined, { timeout }).catch(() => false);
  if (!resizable) return point;
  let p = point;
  for (let i = 0; i < 12 && inResizeGrip(box, p); i++) p = pointInBox(box, rng);
  if (inResizeGrip(box, p)) p = { x: Math.max(box.x + 2, box.x + box.width - RESIZE_GRIP_PX - 2), y: p.y };      // a box too small to avoid it by luck
  return p;
}

/**
 * A requested point plus the tiny landing jitter of a real hand (σ≈0.6 px, the
 * radius clamped to 2 px), kept inside `bounds` ({x0,y0,x1,y1}, half-open).
 * `exact` skips the jitter. With a `dpr` the point is also snapped to the
 * device-pixel grid (q()), and stays inside `bounds`: a point that rounds up to
 * the far edge steps back one device pixel (and one that rounds below the near
 * edge steps forward), because a real pointer cannot be at the edge itself.
 */
function jitterPoint(pt, rng, bounds, exact, dpr) {
  let x = pt.x, y = pt.y;
  if (!exact) {
    let jx = gaussian(rng) * 0.6, jy = gaussian(rng) * 0.6;
    const r = Math.hypot(jx, jy);
    if (r > 2) { jx *= 2 / r; jy *= 2 / r; }
    x += jx; y += jy;
  }
  if (bounds) {
    x = Math.min(bounds.x1 - 0.001, Math.max(bounds.x0, x));
    y = Math.min(bounds.y1 - 0.001, Math.max(bounds.y0, y));
  }
  if (dpr > 0) {
    x = q(x, dpr); y = q(y, dpr);
    if (bounds) {
      const px = 1 / dpr;
      while (x >= bounds.x1 - 1e-9) x -= px;
      while (y >= bounds.y1 - 1e-9) y -= px;
      while (x < bounds.x0 - 1e-9) x += px;
      while (y < bounds.y0 - 1e-9) y += px;
      x = q(x, dpr); y = q(y, dpr);
    }
  }
  return { x, y };
}

/** A landing point from an `--at` offset (CSS px inside the element box) + jitter, kept inside the box and viewport (and on the device-pixel grid when `vp.dpr` is known). */
function pointFromOffset(box, offset, rng, exact, vp) {
  const bounds = {
    x0: Math.max(box.x, 0), y0: Math.max(box.y, 0),
    x1: Math.min(box.x + box.width, vp ? vp.width : Infinity), y1: Math.min(box.y + box.height, vp ? vp.height : Infinity),
  };
  return jitterPoint({ x: box.x + offset.x, y: box.y + offset.y }, rng, bounds, exact, vp ? vp.dpr : undefined);
}

/** Fitts target width of a hit-tested element, clamped to [8, 200]. */
function fittsWidth(hit) {
  if (!hit || !hit.box) return 20;
  return Math.max(8, Math.min(200, Math.min(hit.box.width, hit.box.height)));
}

// --------------------------------------------------------------------------
// Clicks, hovers, drags
// --------------------------------------------------------------------------

// One click gesture at the current pointer position: settle → modifiers down
// (human lead) → down/up with dwell (or an explicit hold) per click →
// modifiers up (lag). Releases exactly what it pressed, even on error.
async function clickSequence(page, rng, o) {
  const { button, clickCount, hold } = o;
  const mods = o.modifiers && o.modifiers.names ? o.modifiers.names : [];
  const st = inputState(page);
  // a click needs the button UP: refuse before touching anything, so a hold made earlier is never disturbed
  if (st.buttons.has(button)) {
    throw new Error(`the ${button} mouse button is already held on this page (mouse-up it first, or run \`release\`)`);
  }
  // tiny settle pause before button press — humans don't click the instant
  // the cursor stops
  await sleep(logNormal(rng, 55, 0.3, 20, 180));
  const pressed = [];
  let held = null;
  try {
    for (const m of mods) {
      if (await pressModifier(page, m)) pressed.push(m);
      await sleep(logNormal(rng, 70, 0.3, 40, 120));         // lead: modifier before the click
    }
    for (let i = 0; i < clickCount; i++) {
      held = i + 1;
      await mouseDown(page, button, i + 1);
      // dwell time mousedown→mouseup (or the explicit hold)
      await sleep(hold != null ? hold : logNormal(rng, 70, 0.3, 30, 180));
      await mouseUp(page, button, i + 1);
      held = null;
      if (i + 1 < clickCount) {
        await sleep(logNormal(rng, 110, 0.25, 60, 220));
      }
    }
  } finally {
    // release only what THIS click pressed (the button was verified up on entry)
    if (held != null) await quietly(() => mouseUp(page, button, held));
    if (pressed.length) {
      await quietly(() => sleep(logNormal(rng, 55, 0.35, 20, 140)));     // lag: modifier after the click
      for (const m of pressed.reverse()) {
        await quietly(() => releaseModifier(page, m));
        await quietly(() => sleep(logNormal(rng, 35, 0.35, 12, 90)));
      }
    }
  }
}

async function clickAt(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  await moveTo(page, x, y, opts);
  await clickSequence(page, rng, {
    button: opts.button || 'left', clickCount: opts.clickCount || 1, hold: opts.hold, modifiers: opts.modifiers,
  });
}

// --------------------------------------------------------------------------
// High-level operations on a Locator
// --------------------------------------------------------------------------

async function resolveBox(locator, timeoutMs, opts = {}) {
  const page = opts.page;
  const rng  = opts.rng || Math.random;
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });

  // If we have a page handle and the element is off-screen, scroll via real
  // wheel events toward it (or, when the caller passes `opts.scroll(dy)`, by
  // whatever input the profile has: finger drags on a touch-only page, where a
  // wheel would contradict the fingerprint). Fall back to
  // scrollIntoViewIfNeeded after that pass closes most of the distance.
  if (page) {
    try {
      let box = await locator.boundingBox({ timeout: timeoutMs });
      if (box) {
        const vp = await viewportMetrics(page);        // the REAL viewport (viewportSize() is null here)
        const topMargin = 80;        // leave the sticky header area alone
        const bottomMargin = vp.height - 80;
        let tries = 0;
        while (tries++ < 6) {
          box = await locator.boundingBox({ timeout: timeoutMs });
          if (!box) break;
          const elTop = box.y;
          const elBot = box.y + box.height;
          if (elTop >= topMargin && elBot <= bottomMargin) break;
          // decide how much to wheel
          let wheelDelta;
          if (elTop < topMargin)      wheelDelta = Math.round(elTop - (topMargin + 40) - rng() * 50);
          else                        wheelDelta = Math.round(elBot - (bottomMargin - 40) + rng() * 50);
          if (typeof opts.scroll === 'function') await opts.scroll(wheelDelta);
          else await humanScroll(page, wheelDelta, { rng });
        }
      }
    } catch { /* fall through to scrollIntoViewIfNeeded */ }
  }

  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
  const box = await locator.boundingBox({ timeout: timeoutMs });
  if (!box) throw new Error('element has no bounding box (detached or 0-size)');
  return box;
}

// Where to land inside a resolved box: the caller's `--at` offset (validated: it must lie inside the
// box; css or screenshot space) plus the tiny hand jitter, else the usual human distribution.
async function landingPoint(page, box, opts, rng) {
  if (!opts.at) return pointInBox(box, rng);
  const vp = await viewportMetrics(page);
  const off = coords.resolveOffset(opts.at, opts.atSpace || 'css', vp, box);
  return pointFromOffset(box, off, rng, opts.exact, vp);
}

async function humanClick(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const button = opts.button || 'left';
  const clickCount = opts.clickCount || 1;
  const t0 = Date.now();
  const box = await resolveBox(locator, timeout, { page, rng });
  // `at`: a caller-chosen offset inside the box (+ the same tiny jitter unless exact); otherwise a human landing point,
  // not in the resize grip of a textarea
  let target = await landingPoint(page, box, opts, rng);
  if (!opts.at) target = await avoidResizeGrip(locator, box, target, rng, timeout);
  const tMoveStart = Date.now();
  await moveTo(page, target.x, target.y, {
    rng, targetW: Math.min(box.width, box.height),
  });
  const landed = snapPoint(page, target);                      // what was dispatched: the device-pixel grid point
  await clickSequence(page, rng, { button, clickCount, hold: opts.hold, modifiers: opts.modifiers });
  return {
    landedAt: { x: round3(landed.x), y: round3(landed.y) },
    targetBox: {
      x: Math.round(box.x), y: Math.round(box.y),
      width: Math.round(box.width), height: Math.round(box.height),
    },
    moveMs: Date.now() - tMoveStart,
    totalMs: Date.now() - t0,
  };
}

async function humanHover(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const box = await resolveBox(locator, timeout, { page, rng });
  const target = await landingPoint(page, box, opts, rng);
  await moveTo(page, target.x, target.y, {
    rng,
    targetW: Math.min(box.width, box.height),
  });
  const landed = snapPoint(page, target);
  return { landedAt: { x: round3(landed.x), y: round3(landed.y) } };
}

/**
 * Click at a viewport CSS point (already validated). Lands on the point plus a
 * hand's tiny jitter (unless exact), inside the viewport.
 */
async function humanClickAt(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  const vp = opts.vp || await viewportMetrics(page);
  noteDpr(page, vp.dpr);
  const t0 = Date.now();
  // the landing point (the hand's jitter unless exact) on the device-pixel grid, inside the viewport
  const target = jitterPoint({ x, y }, rng, { x0: 0, y0: 0, x1: vp.width, y1: vp.height }, opts.exact, vp.dpr);
  const tMove = Date.now();
  await moveTo(page, target.x, target.y, { rng, targetW: opts.targetW });
  const moveMs = Date.now() - tMove;
  await clickSequence(page, rng, {
    button: opts.button || 'left', clickCount: opts.clickCount || 1, hold: opts.hold, modifiers: opts.modifiers,
  });
  return { landedAt: { x: round3(target.x), y: round3(target.y) }, moveMs, totalMs: Date.now() - t0 };
}

async function humanHoverAt(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  const vp = opts.vp || await viewportMetrics(page);
  noteDpr(page, vp.dpr);
  const t0 = Date.now();
  const target = jitterPoint({ x, y }, rng, { x0: 0, y0: 0, x1: vp.width, y1: vp.height }, opts.exact, vp.dpr);
  await moveTo(page, target.x, target.y, { rng, targetW: opts.targetW });
  return { landedAt: { x: round3(target.x), y: round3(target.y) }, moveMs: Date.now() - t0 };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * Drag from `from` to `to` (viewport CSS points) with a human hand:
 * move to start → settle → modifiers down → press → pre-drag hold (~150 ms) →
 * move to the end WITH THE BUTTON HELD (Fitts x1.4, wobble, no overshoot) →
 * settle → release → modifiers up.
 *
 * `opts.html5` selects the routing. HTML5 drag-and-drop mode sends every move
 * while pressed through Playwright's mouse (one awaited move per path point):
 * patchright's DragManager only intercepts drags caused by its own mouse, and
 * raw CDP moves would start a native OS drag loop that never delivers
 * dragenter/dragover/drop. Pointer mode (sliders, canvases, resize handles)
 * uses the raw-CDP coalesced bursts with the button held.
 */
async function humanDrag(page, from, to, opts = {}) {
  const rng = opts.rng || Math.random;
  const button = opts.button || 'left';
  const mods = opts.modifiers && opts.modifiers.names ? opts.modifiers.names : [];
  const st = inputState(page);
  const t0 = Date.now();
  const pressed = [];
  let down = false;
  let dragMs = 0;
  if (st.buttons.has(button)) {
    throw new Error(`the ${button} mouse button is already held on this page (mouse-up it first, or run \`release\`)`);
  }
  try {
    await moveTo(page, from.x, from.y, { rng, targetW: opts.fromW });
    await sleep(logNormal(rng, 55, 0.3, 20, 180));            // settle
    for (const m of mods) {
      if (await pressModifier(page, m)) pressed.push(m);
      await sleep(logNormal(rng, 70, 0.3, 40, 120));
    }
    st.html5 = !!opts.html5;
    down = true;
    await mouseDown(page, button, 1);
    await sleep(logNormal(rng, 150, 0.35, 80, 400));          // pre-drag hold
    const tDrag = Date.now();
    await moveTo(page, to.x, to.y, { rng, targetW: opts.toW, noOvershoot: true, durationScale: 1.4 });
    dragMs = Date.now() - tDrag;
    await sleep(80 + rng() * 120);                            // settle 80-200 ms
    await mouseUp(page, button, 1);
    down = false;
  } catch (e) {
    // an HTML5 drag still in flight: cancel it (Escape) instead of dropping on whatever is under the cursor
    if (down && st.html5) await quietly(() => page.keyboard.press('Escape'));
    throw e;
  } finally {
    if (down) await quietly(() => mouseUp(page, button, 1));
    st.html5 = false;
    if (pressed.length) {
      await quietly(() => sleep(logNormal(rng, 55, 0.35, 20, 140)));
      for (const m of pressed.reverse()) await quietly(() => releaseModifier(page, m));
    }
  }
  return { durationMs: Date.now() - t0, dragMs };
}

// --------------------------------------------------------------------------
// Keyboard
// --------------------------------------------------------------------------

// Map a character to a reasonable per-keystroke base mean (ms). Letters are
// fast, digits and symbols slightly slower, shifted chars slower still.
function charBaseMs(ch) {
  if (ch === ' ') return 140;                     // spaces a bit slower
  if (/[.,!?;:]/.test(ch)) return 170;            // punctuation slower
  if (/[0-9]/.test(ch)) return 130;
  if (/\p{Lu}/u.test(ch)) return 150;             // Shift hold
  if (/\p{Ll}/u.test(ch)) return 95;
  return 140;                                      // symbols and other
}

// The pace of humanType in milliseconds per user-perceived character, over ordinary text: the mean of its own delay model
// (per-character base x burst, the word-start and punctuation extras, the rare long pause) plus the key dwell and the Shift
// lead/lag of capitals. human.sanity.js re-measures it against the real model, so it cannot drift unnoticed.
const TYPING_MS_PER_CHAR = 190;

/** About how long typing `text` (or `n` characters) like a human takes, in ms. */
function estimateTypingMs(textOrCount) {
  const n = typeof textOrCount === 'number' ? textOrCount : splitGraphemes(String(textOrCount)).length;
  return Math.round(n * TYPING_MS_PER_CHAR);
}

// --- physical-key descriptors for CDP Input.dispatchKeyEvent ---------------
// We emit keystrokes via raw CDP keyed on the PHYSICAL code so we can wrap
// shifted characters in explicit ShiftLeft keydown/keyup events. The old path
// (`page.keyboard.press('A')`) produced a capital with NO Shift key event in
// the stream at all — a physically-impossible signature any keystroke-dynamics
// model flags instantly. Keying on `code` (not the char) also avoids
// Playwright re-resolving Shift and re-introducing the bug. Layouts live in
// ./layouts.js (en + ru); named keys in ./keys.js.
const KEYMAP = layouts.EN.byChar;                                  // kept for compatibility
const SHIFT_DESC = { ...K.NAMED.Shift, layout: 'any' };            // no text
const BACKSPACE_DESC = { ...K.NAMED.Backspace, layout: 'any' };    // no text
const ENTER_DESC = { ...K.NAMED.Enter, layout: 'any' };            // text '\r'

/**
 * Dispatch one key event. Stamps the page's modifier mask (with `o.shift`
 * overriding the Shift bit, for the engine's transient Shift) and mirrors
 * Playwright's rules: while Alt/Control/Meta are held a keystroke is a
 * shortcut and inserts no text (rawKeyDown, no `text`).
 *
 * No explicit timestamp: Chrome stamps a discrete event when it receives it, as
 * it does real input, so the page sees the time it was really dispatched (a
 * stamp "key-down + dwell" on a key-up dispatched at the next 15.6 ms timer tick
 * reached the page up to 16 ms late, which real input never does).
 */
async function sendKey(cdp, st, desc, type, o = {}) {
  const shiftOn = o.shift != null ? o.shift : !!(st.modifiers & K.MOD_BITS.Shift);
  const mods = (st.modifiers & ~K.MOD_BITS.Shift) | (shiftOn ? K.MOD_BITS.Shift : 0);
  const shortcut = (mods & K.SHORTCUT_MASK) !== 0;
  const text = type === 'keyDown' && !shortcut && desc.text ? desc.text : '';
  const ev = {
    type: type === 'keyUp' ? 'keyUp' : (text ? 'keyDown' : 'rawKeyDown'),
    windowsVirtualKeyCode: desc.vk,
    code: desc.code,
    key: desc.key,
    modifiers: mods,
  };
  if (desc.location) ev.location = desc.location;
  if (text) { ev.text = text; ev.unmodifiedText = text; }
  if (o.autoRepeat) ev.autoRepeat = true;
  await cdp.send('Input.dispatchKeyEvent', ev);
}

// Emit a single key as down → (precise dwell) → up. Both events are dispatched
// in real time: the keyUp leaves exactly `dwellMs` after the keyDown did (the
// schedule starts before the keyDown's round trip, so that round trip does not
// stretch the dwell), and Chrome stamps each when it arrives.
async function emitKey(cdp, st, desc, dwellMs, shiftActive) {
  const t0 = timing.now();
  await sendKey(cdp, st, desc, 'keyDown', { shift: shiftActive });
  await timing.preciseSleepUntil(t0 + dwellMs);
  await sendKey(cdp, st, desc, 'keyUp', { shift: shiftActive });
}

// Hold a key for `holdMs`. Past an OS-like autorepeat delay (~500 ms ± 60) the
// keydown repeats with `autoRepeat: true` on a regular ~33 ms timer (OS
// autorepeat is timer-regular, so this is realistic); repeats of printable keys
// carry their text, exactly like holding 'a' on real hardware types "aaaa…".
// The schedule is kept in real time (each repeat and the key-up leave at their
// scheduled instant, measured from t0): the page sees the true intervals.
async function emitHeld(cdp, st, desc, holdMs, rng, shiftActive) {
  const t0 = timing.now();
  await sendKey(cdp, st, desc, 'keyDown', { shift: shiftActive });
  const delay = Math.max(380, Math.min(650, 500 + gaussian(rng) * 60));
  let repeats = 0;
  if (holdMs > delay) {
    let at = delay;
    while (at < holdMs) {
      await timing.preciseSleepUntil(t0 + at);
      await sendKey(cdp, st, desc, 'keyDown', { autoRepeat: true, shift: shiftActive });
      repeats += 1;
      at += 33 + (rng() - 0.5) * 4;
    }
  }
  await timing.preciseSleepUntil(t0 + holdMs);
  await sendKey(cdp, st, desc, 'keyUp', { shift: shiftActive });
  return repeats;
}

// Shift handling while typing. `ks.on` = Shift is currently down; `ks.own` =
// WE pressed it (transient, held across consecutive shifted chars like a
// typist, released when an unshifted char arrives). A Shift the caller holds
// explicitly (key-down Shift / --modifiers) is never released here.
async function shiftDown(cdp, st, ks, rng) {
  await sendKey(cdp, st, SHIFT_DESC, 'keyDown', { shift: true });
  ks.on = true; ks.own = true;
  await sleep(logNormal(rng, 55, 0.35, 20, 160));   // shift lead
}
async function shiftUp(cdp, st, ks, rng, afterMs) {
  await sendKey(cdp, st, SHIFT_DESC, 'keyUp', { shift: false });
  ks.on = false; ks.own = false;
  if (afterMs !== 0) await sleep(logNormal(rng, 45, 0.35, 15, 140));
}

// Emit a printable char, managing the Shift run: Shift is pressed slightly
// before the first shifted char and held across consecutive shifted chars
// (as a real typist does), released when a non-shifted char arrives.
async function emitChar(cdp, st, desc, dwellMs, ks, rng) {
  if (desc.shift && !ks.on) await shiftDown(cdp, st, ks, rng);
  else if (!desc.shift && ks.on && ks.own) await shiftUp(cdp, st, ks, rng);
  await emitKey(cdp, st, desc, dwellMs, ks.on);
}

/**
 * Playwright's keyboard.press(combo, { delay }) with the dwell slept precisely: down for each token, wait, up in reverse.
 * (Playwright's own `delay` is a setTimeout, so every dwell it produces lands on the OS timer tick.) Used by the human
 * paths that cannot use the CDP key emitter: keys it does not know, and the no-CDP fallback.
 */
async function pwPress(page, combo, dwellMs) {
  const tokens = K.splitCombo(combo);
  const down = [];
  try {
    for (const t of tokens) { await page.keyboard.down(t); down.push(t); }
    if (dwellMs > 0) await sleep(dwellMs);
  } finally {
    for (const t of down.reverse()) await quietly(() => page.keyboard.up(t));
  }
}

// Legacy fallback (only if a CDP session can't be created): the original
// press-based path. Retains the Shift-event gap but keeps the tool functional
// in environments without CDP.
async function legacyType(page, text, rng, typosEnabled) {
  let prev = '';
  let burst = 1.0;
  const chars = splitGraphemes(String(text));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const base = charBaseMs(ch);
    if (/\p{Ll}/u.test(ch)) burst = Math.max(0.65, burst * (rng() < 0.3 ? 0.9 : 1.0));
    else burst = Math.min(1.15, burst + 0.05);
    let delay = logNormal(rng, base * burst, 0.35, 30, 500);
    if (prev === ' ' && ch !== ' ') delay += logNormal(rng, 80, 0.4, 20, 300);
    if (/[.,;:!?]/.test(prev)) delay += logNormal(rng, 120, 0.4, 30, 450);
    if (i > 1 && rng() < 0.015) delay += logNormal(rng, 650, 0.5, 200, 2200);
    await sleep(delay);
    const wrong = typosEnabled && i > 0 && rng() < 0.008 ? layouts.typoFor(ch, rng, 'en') : null;
    if (wrong && layouts.EN.byChar[wrong]) {
      await pwPress(page, wrong, logNormal(rng, 55, 0.3, 20, 130));
      await sleep(logNormal(rng, 220, 0.4, 90, 700));
      await pwPress(page, 'Backspace', logNormal(rng, 45, 0.3, 20, 110));
      await sleep(logNormal(rng, 140, 0.3, 60, 400));
    }
    if (layouts.EN.byChar[ch]) await pwPress(page, ch, logNormal(rng, 55, 0.3, 20, 130));
    else await page.keyboard.insertText(ch);
    prev = ch;
  }
}

const GRAPHEMES = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** Split into user-perceived characters (an emoji with modifiers, or é as e+U+0301, is ONE unit). */
function splitGraphemes(s) {
  return GRAPHEMES ? Array.from(GRAPHEMES.segment(s), (x) => x.segment) : Array.from(s);
}

// A human reaches for the layout shortcut (Alt+Shift by default, Ctrl+Shift via
// NATIVEWRIGHT_LAYOUT_SWITCH) when the next character belongs to the other
// layout. The page sees those modifier keydown/keyup events exactly as on
// real hardware (the OS layout itself is not changed: only the events differ).
async function switchLayout(page, st, rng, target) {
  await sleep(logNormal(rng, 280, 0.35, 120, 800));          // notice, reach for the shortcut
  const chord = layouts.switchChord();
  const pressed = [];
  try {
    for (const m of chord) {
      if (await pressModifier(page, m)) pressed.push(m);
      await sleep(logNormal(rng, 65, 0.3, 30, 140));
    }
    await sleep(logNormal(rng, 40, 0.3, 20, 110));
  } finally {
    for (const m of pressed.reverse()) {
      await quietly(() => releaseModifier(page, m));
      await quietly(() => sleep(logNormal(rng, 50, 0.3, 20, 120)));
    }
  }
  st.layout = target;
  await sleep(logNormal(rng, 140, 0.35, 60, 400));           // glance at the layout indicator
}

// How a single user-perceived character is entered.
function classifyChar(ch, st) {
  if (ch === '\n' || ch === '\r\n' || ch === '\r') return { kind: 'key', desc: ENTER_DESC, switchTo: null };
  if (Array.from(ch).length === 1) {
    const r = layouts.resolveChar(ch, st.layout);
    if (r) return { kind: 'key', desc: r.desc, switchTo: r.switchTo };
  }
  return { kind: 'insert' };            // emoji, CJK, other scripts: committed like an IME / emoji picker
}

// Type a string one char at a time with realistic inter-key gaps, per-key
// dwell, burstiness, explicit Shift handling, and optional typo-then-correct
// patterns. `opts.typos`:
//   'off'  — never insert typos (use for passwords, credentials)
//   'on'   — ~0.8% per char
//   'auto' — default; detects password fields and disables typos for them
//
// Characters are entered by what a person would do: the physical key of the
// active layout (Latin or Russian), after a human layout-switch chord when the
// character belongs to the other layout; characters on neither layout go
// through Input.insertText (IME / emoji-picker style) — never a keydown with
// an empty code/keyCode, which is a detectable signature.
async function humanType(page, text, opts = {}) {
  const rng = opts.rng || Math.random;
  const typosMode = opts.typos || 'auto';
  let typosEnabled = typosMode === 'on';
  if (typosMode === 'auto') {
    // cheap heuristic: check the currently-focused element's type. If it
    // looks like a password/code/OTP field, disable typos for it.
    try {
      const looksSensitive = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a) return false;
        const t = (a.getAttribute && a.getAttribute('type') || '').toLowerCase();
        const n = (a.getAttribute && a.getAttribute('name') || '').toLowerCase();
        const id = (a.id || '').toLowerCase();
        const ac = (a.getAttribute && a.getAttribute('autocomplete') || '').toLowerCase();
        return t === 'password' || /pass|pwd|otp|code|cvv|pin|secret|token/.test(n + ' ' + id + ' ' + ac);
      });
      typosEnabled = !looksSensitive;
    } catch { typosEnabled = false; }
  }

  const cdp = await getCdpSession(page);
  if (!cdp) return legacyType(page, text, rng, typosEnabled);

  const st = inputState(page);
  // Start from the Shift that is ALREADY held (key-down Shift / --modifiers): never press it twice, never release it.
  const ks = { on: !!(st.modifiers & K.MOD_BITS.Shift), own: false };
  const explicitShift = ks.on;
  const chars = splitGraphemes(String(text));
  let prev = '';
  let burst = 1.0;
  try {
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const base = charBaseMs(ch);

      if (/\p{Ll}/u.test(ch)) burst = Math.max(0.65, burst * (rng() < 0.3 ? 0.9 : 1.0));
      else burst = Math.min(1.15, burst + 0.05);

      let delay = logNormal(rng, base * burst, 0.35, 30, 500);
      if (prev === ' ' && ch !== ' ') delay += logNormal(rng, 80, 0.4, 20, 300);
      if (/[.,;:!?]/.test(prev)) delay += logNormal(rng, 120, 0.4, 30, 450);
      if (i > 1 && rng() < 0.015) delay += logNormal(rng, 650, 0.5, 200, 2200);
      await sleep(delay);

      const how = classifyChar(ch, st);

      // not on any layout (emoji, CJK, other scripts): release our own Shift,
      // then commit the text the way an IME / emoji picker does.
      if (how.kind === 'insert') {
        if (ks.on && ks.own) await shiftUp(cdp, st, ks, rng, 0);
        await page.keyboard.insertText(ch);
        prev = ch;
        continue;
      }

      // belongs to the other layout: switch first (the chord uses Shift, so drop ours)
      if (how.switchTo) {
        if (ks.on && ks.own) await shiftUp(cdp, st, ks, rng, 0);
        await switchLayout(page, st, rng, how.switchTo);
      }
      let desc = how.desc;
      // with Shift explicitly held, hardware yields the shifted key of that physical key
      if (explicitShift) desc = layouts.withShiftHeld(desc);

      // typo: emit a wrong PHYSICALLY-ADJACENT neighbour, notice, Backspace, then the real char.
      const wrongCh = typosEnabled && i > 0 && rng() < 0.008 ? layouts.typoFor(ch, rng, st.layout) : null;
      const wrongDesc = wrongCh ? layouts.LAYOUTS[st.layout].byChar[wrongCh] : null;
      if (wrongDesc) {
        await emitChar(cdp, st, explicitShift ? layouts.withShiftHeld(wrongDesc) : wrongDesc, logNormal(rng, 60, 0.3, 25, 140), ks, rng);
        await sleep(logNormal(rng, 220, 0.4, 90, 700));                 // "noticing" pause
        await emitKey(cdp, st, BACKSPACE_DESC, logNormal(rng, 50, 0.3, 20, 120), ks.on);
        await sleep(logNormal(rng, 140, 0.3, 60, 400));
      }

      await emitChar(cdp, st, desc, logNormal(rng, 62, 0.3, 25, 140), ks, rng);
      prev = ch;
    }
  } finally {
    // never leave OUR Shift logically stuck, even if something threw mid-string
    if (ks.on && ks.own) {
      try { await sendKey(cdp, st, SHIFT_DESC, 'keyUp', { shift: false }); } catch { /* ignore */ }
      ks.on = false; ks.own = false;
    }
  }
}

// --- key presses, holds and combos -----------------------------------------

/**
 * Resolve one token of a key spec ("Enter", "Control", "a", "A", "й", "KeyA")
 * to { name, desc, modifier, switchTo }. Throws on an unknown key.
 */
function resolveKeyToken(token, st) {
  const t = String(token);
  if (t === '') throw new Error('empty key');
  const nk = K.namedKey(t);
  if (nk) return { name: nk.name, desc: { ...nk, layout: 'any' }, modifier: nk.modifier || null, switchTo: null };
  if (Array.from(t).length === 1) {
    const r = layouts.resolveChar(t, st.layout);
    if (r) return { name: t, desc: r.desc, modifier: null, switchTo: r.switchTo };
    throw new Error(`unknown key '${t}': not a named key and not on the US or Russian layout`);
  }
  const byCode = layouts.byCodeToken(t, st.layout);
  if (byCode) return { name: t, desc: byCode, modifier: null, switchTo: null };
  throw new Error(
    `unknown key '${t}'. Use a named key (Shift, Control, Alt, Meta, Enter, Tab, Escape, Backspace, Delete, Insert, ` +
    'Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, Space, F1-F12), a single printable character, or a physical code like KeyA.');
}

/** Press and keep holding a key (explicit `key-down`, or a held key inside a combo). */
async function keyDown(page, spec, o = {}) {
  const st = inputState(page);
  if (spec.modifier) {
    const pressed = await pressModifier(page, spec.modifier);
    if (!pressed && o.repeatIfHeld) {
      // already held: a repeated key-down is an auto-repeat on real hardware
      await page.keyboard.down(spec.modifier);
    }
    return pressed;
  }
  const already = st.keys.has(spec.name);
  st.keys.add(spec.name);
  st.keyDescs.set(spec.name, spec);
  if (!already) track(st, 'key', spec.name);
  const cdp = await getCdpSession(page);
  if (cdp) await sendKey(cdp, st, spec.desc, 'keyDown', { autoRepeat: already });
  else await page.keyboard.down(spec.desc.key.length === 1 ? spec.desc.key : spec.name);
  return !already;
}

async function keyUp(page, spec) {
  const st = inputState(page);
  if (spec.modifier) { await releaseModifier(page, spec.modifier); return; }
  try {
    const cdp = await getCdpSession(page);
    if (cdp) await sendKey(cdp, st, spec.desc, 'keyUp', {});
    else await page.keyboard.up(spec.desc.key.length === 1 ? spec.desc.key : spec.name);
  } finally {
    st.keys.delete(spec.name);
    st.keyDescs.delete(spec.name);
    untrack(st, 'key', spec.name);
  }
}

// Press a key spec once with a human dwell (or an explicit hold with
// autorepeat). Returns the number of autorepeat keydowns emitted.
async function pressMain(page, st, spec, rng, hold) {
  const dwell = hold != null ? hold : logNormal(rng, 70, 0.3, 30, 160);
  const shiftOn = !!(st.modifiers & K.MOD_BITS.Shift);
  // macOS only runs shortcuts like Cmd+V / Cmd+A from editing `commands`, which
  // patchright's own keyboard attaches; the CDP emitter does not. Use it there.
  if (process.platform === 'darwin' && (st.modifiers & K.SHORTCUT_MASK)) {
    // Playwright knows the US layout's characters and key names only: a character of another layout (Russian 'ф' for Cmd+A) is
    // named by its physical code instead ('KeyA'), which it resolves
    const ch = spec.desc.key;
    const pwName = ch && ch.length === 1 ? (layouts.EN.byChar[ch] ? ch : (spec.desc.code || ch)) : spec.name;
    await page.keyboard.down(pwName);
    await sleep(dwell);
    await page.keyboard.up(pwName);
    return 0;
  }
  const cdp = await getCdpSession(page);
  if (!cdp) { await pwPress(page, spec.desc.key.length === 1 ? spec.desc.key : spec.name, dwell); return 0; }
  // visible in `pages` while it is down; never drop a key that is ALSO held explicitly (key-down)
  const had = st.keys.has(spec.name);
  if (!had) { st.keys.add(spec.name); track(st, 'key', spec.name); }
  try {
    if (hold != null) return await emitHeld(cdp, st, spec.desc, hold, rng, shiftOn);
    await emitKey(cdp, st, spec.desc, dwell, shiftOn);
    return 0;
  } finally {
    if (!had) { st.keys.delete(spec.name); untrack(st, 'key', spec.name); }
  }
}

async function pressViaPlaywright(page, combo, rng, hold, repeat) {
  for (let r = 0; r < repeat; r++) {
    if (r > 0) await sleep(logNormal(rng, 120, 0.3, 60, 320));
    // down -> precise dwell -> up (the explicit hold, else a human dwell: not a zero-length press)
    await pwPress(page, combo, hold != null ? hold : logNormal(rng, 70, 0.3, 30, 160));
  }
  return { tokens: K.splitCombo(combo), presses: repeat, autoRepeats: 0, native: true };
}

/**
 * A human key press: `Enter`, `a`, `Control+A`, `Control+Shift+ArrowLeft`.
 * Modifiers first (human lead of 40-120 ms each, via Playwright's keyboard so
 * they are stamped on its mouse events too), the main key through the CDP key
 * emitter with a real-time dwell, then releases in reverse with lag.
 *   opts.hold    keep the main key down that many ms (autorepeat after ~500 ms)
 *   opts.repeat  press n times with human gaps
 * Keys the emitter doesn't know fall back to Playwright's keyboard.
 */
async function humanPress(page, combo, opts = {}) {
  const rng = opts.rng || Math.random;
  const st = inputState(page);
  const hold = opts.hold != null ? Number(opts.hold) : null;
  const repeat = Math.max(1, Math.floor(opts.repeat || 1));
  const tokens = K.splitCombo(combo);
  let specs;
  try { specs = tokens.map((t) => resolveKeyToken(t, st)); }
  catch (e) {
    // not in the emitter's vocabulary (NumpadEnter, ContextMenu, ...): Playwright's keyboard knows more
    return pressViaPlaywright(page, combo, rng, hold, repeat);
  }
  let main = specs[specs.length - 1];
  // A shortcut (Control/Alt/Meta + key) is pressed by POSITION: on a Russian layout Ctrl+A is the key that
  // types 'ф', and nobody switches layouts to select all. Only typed characters trigger a layout switch.
  if (main.switchTo && specs.length > 1 && specs.slice(0, -1).some((s) => s.modifier && s.modifier !== 'Shift')) {
    const slot = (layouts.LAYOUTS[st.layout] || {}).byCode;
    const here = slot && slot[main.desc.code] && (main.desc.shift ? slot[main.desc.code].shifted : slot[main.desc.code].base);
    if (here) { main = { ...main, desc: here, switchTo: null }; specs[specs.length - 1] = main; }
  }
  let autoRepeats = 0;
  for (let r = 0; r < repeat; r++) {
    if (r > 0) await sleep(logNormal(rng, 120, 0.3, 60, 320));       // human gap between presses
    const pressedMods = [];
    const heldKeys = [];
    try {
      for (const spec of specs.slice(0, -1)) {
        if (spec.switchTo) await switchLayout(page, st, rng, spec.switchTo);
        if (spec.modifier) { if (await pressModifier(page, spec.modifier)) pressedMods.push(spec.modifier); }
        else if (await keyDown(page, spec)) heldKeys.push(spec);      // a key the caller already holds is never released here
        await sleep(logNormal(rng, 70, 0.3, 40, 120));               // human lead
      }
      if (main.switchTo) await switchLayout(page, st, rng, main.switchTo);
      let mainSpec = main;
      if (main.modifier) {
        // a lone modifier press ("Shift", "Control"): tap it
        const pressedNow = await pressModifier(page, main.modifier);
        await sleep(hold != null ? hold : logNormal(rng, 70, 0.3, 30, 160));
        if (pressedNow) await releaseModifier(page, main.modifier);
      } else {
        if (main.desc.shift && !(st.modifiers & K.MOD_BITS.Shift)) {
          const slot = (layouts.LAYOUTS[main.desc.layout] || {}).byCode;
          const baseKey = slot && slot[main.desc.code] && slot[main.desc.code].base;
          if (specs.length > 1 && baseKey && /\p{L}/u.test(main.desc.key)) {
            // "Control+A" is the A key, not Shift+A: after a modifier, a capital LETTER only names the key
            mainSpec = { ...main, desc: baseKey };
          } else {
            // a lone shifted char ("A", "!") — or a symbol in a combo: Shift is part of the gesture
            if (await pressModifier(page, 'Shift')) pressedMods.push('Shift');
            await sleep(logNormal(rng, 55, 0.35, 20, 160));
          }
        } else if (!main.desc.shift && (st.modifiers & K.MOD_BITS.Shift)) {
          mainSpec = { ...main, desc: layouts.withShiftHeld(main.desc) };   // Shift held: the shifted key of that physical key
        }
        autoRepeats += await pressMain(page, st, mainSpec, rng, hold);
      }
    } finally {
      // releases in reverse with lag, exactly what THIS press pressed
      const lag = () => quietly(() => sleep(logNormal(rng, 55, 0.35, 20, 140)));
      for (const spec of heldKeys.reverse()) { await lag(); await quietly(() => keyUp(page, spec)); }
      for (const m of pressedMods.reverse()) { await lag(); await quietly(() => releaseModifier(page, m)); }
    }
  }
  return { tokens, presses: repeat, autoRepeats, native: false };
}

/** Release everything this page holds (mouse buttons and keys), in reverse order of pressing. */
async function releaseAll(page) {
  const st = inputState(page);
  const released = { buttons: [], keys: [] };
  const errors = [];
  for (const h of st.order.slice().reverse()) {
    try {
      if (h.kind === 'button') {
        if (st.buttons.has(h.name)) { await mouseUp(page, h.name, 1); released.buttons.push(h.name); }
      } else if (st.keys.has(h.name)) {
        const spec = st.keyDescs.get(h.name) || (K.canonicalModifier(h.name) ? { name: h.name, modifier: h.name } : null);
        if (spec) await keyUp(page, spec);
        released.keys.push(h.name);
      }
    } catch (e) { errors.push(`${h.kind} ${h.name}: ${e.message}`); }
  }
  // whatever is left is stale bookkeeping: zero it
  st.buttons.clear(); st.keys.clear(); st.keyDescs.clear(); st.order.length = 0;
  st.modifiers = 0; st.lastButton = 'none'; st.html5 = false;
  return { released, errors };
}

// --------------------------------------------------------------------------
// Scroll
// --------------------------------------------------------------------------

// Roll a quantised wheel (see ./wheel.js): flicks of 15-40 ms-spaced events
// worth one notch each (100 px by default, or the human's calibrated delta),
// with reading pauses between flicks. A wheel has no partial notches, so the
// distance is approximate; the container's real before/after is reported.
//
// The wheel acts on the SCROLL CONTAINER under the pointer — the nearest
// ancestor that scrolls on the axis (an inner panel in most SPAs), else the
// document — and edge detection tracks THAT container's scroll offset, not
// window.scrollY (which never moves when an inner container scrolls: the old
// code stopped after 2 ticks / ~450 px on such pages).
//   opts.axis    'y' (default) | 'x'
//   opts.toEdge  scroll until the container's edge in the direction of totalPx's sign
async function humanScroll(page, totalPx, opts = {}) {
  const rng = opts.rng || Math.random;
  const axis = opts.axis === 'x' ? 'x' : 'y';
  const sign = totalPx >= 0 ? 1 : -1;
  const toEdge = !!opts.toEdge;
  const pos = await getPos(page, rng);
  await syncPointer(page);

  const { handle, descriptor } = await inspect.findScrollContainer(page, pos.x, pos.y, axis, sign);
  const at = (s) => (axis === 'x' ? s.x : s.y);
  const maxOf = (s) => (axis === 'x' ? s.maxX : s.maxY);
  try {
    const model = wheel.activeModel();
    const player = wheel.makePlayer(model, rng, { logNormal, gaussian });
    const before = await inspect.containerState(handle);
    const scrollable = maxOf(before) > 0;
    const target = Math.abs(totalPx);
    const result = (after, sent, events, note) => ({
      axis, requested: toEdge ? 'edge' : totalPx, sent: sent * sign, events,
      scrolled: at(after) - at(before), container: descriptor,
      before: { x: before.x, y: before.y }, after: { x: after.x, y: after.y },
      scrollable, wheelModel: model.source, quantum: model.quantum, ...(note ? { note } : {}),
    });
    if (toEdge && !scrollable) return result(before, 0, 0, 'container cannot scroll on this axis');

    let sent = 0, events = 0, stuck = 0, last = before;
    const MAX_EVENTS = 3000;
    for (let i = 0; i < MAX_EVENTS; i++) {
      const remaining = toEdge ? undefined : target - sent;
      if (!toEdge && sent > 0 && remaining <= model.quantum / 2) break;
      const ev = player.next(remaining);
      await page.mouse.wheel(axis === 'x' ? sign * ev.delta : 0, axis === 'y' ? sign * ev.delta : 0);
      sent += ev.delta; events += 1;
      await sleep(ev.gapMs);
      // measure at the end of each flick (the reading pause): edge / stuck detection on the REAL container
      if (scrollable && ev.endOfFlick) {
        let s;
        try { s = await inspect.containerState(handle); } catch { break; }
        const moved = Math.abs(at(s) - at(last));
        stuck = moved < 0.5 ? stuck + 1 : 0;
        const atEdge = sign > 0 ? at(s) >= maxOf(s) - 0.5 : at(s) <= 0.5;
        last = s;
        if (atEdge || stuck >= 2) break;
      }
    }
    // let a running scroll animation settle before reporting
    let prevS = await inspect.containerState(handle).catch(() => before);
    for (let k = 0; k < 10; k++) {
      await coarseSleep(60);                              // polling the page: no input event follows
      const s = await inspect.containerState(handle).catch(() => prevS);
      if (Math.abs(at(s) - at(prevS)) < 0.5) { prevS = s; break; }
      prevS = s;
    }
    return result(prevS, sent, events);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/**
 * Robotic scroll: set the scroll container's offset directly (no wheel events).
 * The container is the same one the wheel would act on at `at`.
 */
async function rawScroll(page, at, totalPx, opts = {}) {
  const axis = opts.axis === 'x' ? 'x' : 'y';
  const sign = totalPx >= 0 ? 1 : -1;
  const toEdge = !!opts.toEdge;
  const { handle, descriptor } = await inspect.findScrollContainer(page, at.x, at.y, axis, sign);
  try {
    const before = await inspect.containerState(handle);
    await handle.evaluate((el, o) => {
      if (o.toEdge) {
        if (o.axis === 'x') el.scrollTo({ left: o.sign > 0 ? el.scrollWidth : 0, behavior: 'instant' });
        else el.scrollTo({ top: o.sign > 0 ? el.scrollHeight : 0, behavior: 'instant' });
      } else if (o.axis === 'x') el.scrollBy({ left: o.px, behavior: 'instant' });
      else el.scrollBy({ top: o.px, behavior: 'instant' });
    }, { axis, sign, toEdge, px: totalPx });
    const after = await inspect.containerState(handle);
    return {
      axis, requested: toEdge ? 'edge' : totalPx,
      scrolled: (axis === 'x' ? after.x - before.x : after.y - before.y),
      container: descriptor, before: { x: before.x, y: before.y }, after: { x: after.x, y: after.y },
      scrollable: (axis === 'x' ? before.maxX : before.maxY) > 0,
    };
  } finally { await handle.dispose().catch(() => {}); }
}

// --------------------------------------------------------------------------
// Think-time (between discrete agent actions)
// --------------------------------------------------------------------------

// Think-time is deliberately heterogeneous: most actions have a short
// hand-off pause, some have a medium reading pause, occasional longer pauses
// simulate context-switch. Mixing three regimes prevents a detector from
// fitting a single log-normal to action spacing.
function thinkMs(opts = {}) {
  const rng = opts.rng || Math.random;
  const scale = opts.mean ? opts.mean / 450 : 1;
  const r = rng();
  // Fast hand-off: a brief but NON-ZERO pause. Returning exactly 0 here put a
  // point-mass spike at 0 in the action-spacing histogram (a fittable artifact);
  // a real person essentially never fires two deliberate actions with truly 0ms
  // between them.
  if (r < 0.15) return logNormal(rng, 55 * scale, 0.5, 8, 220 * scale);  // 15% fast
  if (r < 0.75) return logNormal(rng, 320 * scale, 0.35, 80, 900);   // short
  if (r < 0.95) return logNormal(rng, 750 * scale, 0.4, 300, 1800);  // medium
  return logNormal(rng, 1800 * scale, 0.45, 700, 4500);              // longer
}

async function think(opts = {}) {
  const ms = thinkMs(opts);
  if (ms > 0) await sleep(ms);
}

// "clear this text field the way a human would". The selection GESTURE is
// randomized each call so the field-edit doesn't emit a byte-identical
// triple-click+Ctrl+A+Delete macro every time (a repeatable behavioral
// signature). Whatever the gesture, we always finish with select-all before the
// delete key so the field is reliably emptied for inputs, multi-line
// textareas, and React-controlled contenteditables alike.
//
// The select-all and the delete key go through humanPress (the CDP key emitter),
// not Playwright's keyboard.press: that one names the wrong `key` when the page's
// layout state is Russian (humanPress presses the physical key), uses Control
// on macOS (where Ctrl+A moves the caret and clears nothing: it is Cmd+A there),
// and its `delay` is a setTimeout, quantised to the OS timer tick.
async function humanClearField(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const box = await resolveBox(locator, timeout, { page, rng });
  const target = await avoidResizeGrip(locator, box, pointInBox(box, rng), rng, timeout);
  await moveTo(page, target.x, target.y, {
    rng, targetW: Math.min(box.width, box.height),
  });
  await sleep(logNormal(rng, 50, 0.3, 20, 150));

  // Pick how many times to click before the select-all: triple (select line),
  // double (select word), single (just focus/caret), or none (move only).
  const r = rng();
  let clicks = r < 0.5 ? 3 : r < 0.75 ? 1 : r < 0.92 ? 2 : 0;
  if (clicks === 0) {
    // "move only" is a fine way to clear a field that already has the focus - and a bug on one that has not: select-all and
    // the delete key would act on whatever IS focused, and the text that follows would be typed into it (measured: in 1 of 14
    // rounds `fill` cleared and typed into the textarea that was focused before). So a field without the focus gets a click.
    const has = await locator.evaluate((el) => { const a = el.ownerDocument.activeElement; return a === el || el.contains(a); }, undefined, { timeout })
      .catch(() => false);
    if (!has) clicks = 1;
  }
  for (let i = 0; i < clicks; i++) {
    await mouseDown(page);
    try { await sleep(logNormal(rng, 40, 0.25, 15, 100)); }
    finally { await mouseUp(page); }
    if (i + 1 < clicks) await sleep(logNormal(rng, 70, 0.25, 30, 150));
  }
  await sleep(logNormal(rng, 80, 0.3, 30, 180));

  // Reliable select-all (Cmd+A on macOS, Ctrl+A elsewhere), then a delete key chosen at random
  // (Delete vs Backspace — both empty a fully-selected field; real users use either).
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await humanPress(page, mod + '+a', { rng });
  await sleep(logNormal(rng, 70, 0.3, 25, 180));
  const delKey = rng() < 0.5 ? 'Delete' : 'Backspace';
  await humanPress(page, delKey, { rng });
}

// --------------------------------------------------------------------------

module.exports = {
  makeRng,
  gaussian, logNormal, sleep, coarseSleep, sleepUntil,
  bezier, buildControlPoints, samplePath, easeInOut, easeOut, easeLinearish,
  moveDurationMs,
  // input state + the device-pixel grid
  inputState, inputSnapshot, viewportMetrics, releaseAll, syncPointer,
  q, dprOf, noteDpr, snapPoint, rawMove,
  getPos, setPos, getCdpSession, moveTo, traversePath, clickAt,
  mouseDown, mouseUp, pressModifier, releaseModifier,
  // landing points + gestures
  pointInBox, jitterPoint, pointFromOffset, fittsWidth, resolveBox, avoidResizeGrip, inResizeGrip,
  humanClick, humanHover, humanClickAt, humanHoverAt, humanDrag,
  // keyboard
  humanType, humanPress, resolveKeyToken, keyDown, keyUp, switchLayout, splitGraphemes, KEYMAP,
  pwPress, estimateTypingMs, TYPING_MS_PER_CHAR,
  // scroll, misc
  humanScroll, rawScroll, humanClearField,
  think, thinkMs, charBaseMs,
};
