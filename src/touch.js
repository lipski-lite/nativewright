'use strict';

/**
 * Touch gestures (tap, swipe, pinch) via CDP Input.dispatchTouchEvent with
 * human finger paths: touchStart -> frame-paced touchMove -> touchEnd, with
 * the contact radius and force varying like a real fingertip.
 *
 * GATED, on purpose. A browser that reports no touch support
 * (navigator.maxTouchPoints === 0) still RECEIVES touch events when they are
 * dispatched over CDP (verified empirically), so a script could send touches
 * from a "mouse-only desktop": a physically impossible, detectable
 * contradiction. These functions therefore refuse unless the page itself
 * reports touch capability. The opt-in is NATIVEWRIGHT_TOUCH=1 at daemon start
 * (a touch-only, tablet-class device: it has no mouse); see README "Touch".
 *
 * Touch coordinates are NOT snapped to the device-pixel grid the way pointer
 * coordinates are (human.q): a digitizer reports sub-pixel positions. Touch events
 * carry no explicit timestamp either: Chrome stamps them when it receives them.
 *
 * @module touch
 */

const human = require('./human');
const timing = require('./timing');
const K = require('./keys');

const FRAME_MS = 16.7;       // a 60 Hz touch sensor
let fingerIdSeq = 0;         // touch identifiers keep counting up, like a real digitizer

/**
 * Refuse unless the page reports touch capability.
 * @param {number} [fingers=1] contacts the gesture needs (pinch needs 2)
 * @returns {Promise<{maxTouchPoints:number}>}
 */
async function assertTouchCapable(page, fingers = 1) {
  let t;
  try {
    t = await page.evaluate(() => ({
      maxTouchPoints: navigator.maxTouchPoints,
      ontouchstart: 'ontouchstart' in window,
    }));
  } catch (e) {
    throw new Error('touch refused: could not read the page\'s touch capability (' + e.message + ')');
  }
  if (!(t.maxTouchPoints > 0) || !t.ontouchstart) {
    throw new Error(
      `touch refused: this page reports navigator.maxTouchPoints=${t.maxTouchPoints} and 'ontouchstart' in window=${t.ontouchstart} ` +
      '(a desktop with no touchscreen). Dispatching touch events from a device that claims to have no touch support is a ' +
      'physically impossible, detectable contradiction, so tap / swipe / pinch are disabled. ' +
      'To use them, start the daemon in a touch-capable configuration: NATIVEWRIGHT_TOUCH=1 nativewright start ' +
      '(use a separate profile: --profile=<name>).');
  }
  if (fingers > 1 && t.maxTouchPoints < fingers) {
    throw new Error(
      `touch refused: this gesture needs ${fingers} simultaneous contacts but the page reports navigator.maxTouchPoints=${t.maxTouchPoints}; ` +
      'a device cannot produce more contacts than it reports. Start the daemon with NATIVEWRIGHT_TOUCH=1 (reports 10).');
  }
  return t;
}

/** A fingertip: contact size and pressure that vary a little from touch to touch. */
function makeFinger(rng) {
  const r = 5.5 + rng() * 4.5;
  return {
    id: fingerIdSeq++ % 1000,
    radiusX: r,
    radiusY: r * (0.9 + rng() * 0.25),
    rotation: Math.round((rng() - 0.5) * 60),
    force0: 0.35 + rng() * 0.25,
  };
}

function pointFor(f, x, y, rng, forceShape) {
  return {
    x, y,
    radiusX: Math.max(2, f.radiusX + human.gaussian(rng) * 0.35),
    radiusY: Math.max(2, f.radiusY + human.gaussian(rng) * 0.35),
    rotationAngle: f.rotation,
    force: Math.max(0.05, Math.min(1, f.force0 * forceShape + human.gaussian(rng) * 0.015)),
    id: f.id,
  };
}

async function send(cdp, st, type, touchPoints) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints, modifiers: st.modifiers });
}

async function sessionFor(page) {
  const cdp = await human.getCdpSession(page);
  if (!cdp) throw new Error('touch needs a CDP session to the page, which could not be created');
  return cdp;
}

/** A tap: land (±1.5 px), rest 40-120 ms with the tiny drift of a living finger, lift. */
async function tap(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  const t0 = Date.now();
  await assertTouchCapable(page, 1);
  const cdp = await sessionFor(page);
  const st = human.inputState(page);
  const f = makeFinger(rng);
  const land = { x: x + human.gaussian(rng) * 0.8, y: y + human.gaussian(rng) * 0.8 };
  let down = false;
  try {
    await send(cdp, st, 'touchStart', [pointFor(f, land.x, land.y, rng, 0.8)]);
    down = true;
    const hold = opts.raw ? 20 : human.logNormal(rng, 75, 0.3, 40, 130);
    const moves = opts.raw ? 0 : Math.floor(hold / 40);          // a resting fingertip drifts a hair
    for (let i = 0; i < moves; i++) {
      await human.sleep(hold / (moves + 1));
      await send(cdp, st, 'touchMove', [pointFor(f, land.x + human.gaussian(rng) * 0.4, land.y + human.gaussian(rng) * 0.4, rng, 1)]);
    }
    await human.sleep(hold / (moves + 1));
    await send(cdp, st, 'touchEnd', []);
    down = false;
  } finally {
    if (down) { try { await send(cdp, st, 'touchEnd', []); } catch { /* ignore */ } }
  }
  return { at: { x: Math.round(land.x * 10) / 10, y: Math.round(land.y * 10) / 10 }, durationMs: Date.now() - t0 };
}

/** A swipe/flick from `from` to `to`: a curved path sampled at the touch-sensor rate, ease-out like a flick. */
async function swipe(page, from, to, opts = {}) {
  const rng = opts.rng || Math.random;
  const t0 = Date.now();
  await assertTouchCapable(page, 1);
  const cdp = await sessionFor(page);
  const st = human.inputState(page);
  const f = makeFinger(rng);
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const speed = 0.9 + rng() * 1.6;                                    // px per ms
  const duration = opts.raw ? Math.max(60, d / 4) : Math.max(140, Math.min(1000, d / speed + 40 + rng() * 60));
  const n = Math.max(4, Math.round(duration / FRAME_MS));
  const { p1, p2 } = human.buildControlPoints(from, to, rng);
  // fingers swipe along gentle arcs: shrink the generic mouse-path bend toward the straight line
  const shrink = (p, a, k) => ({ x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k });
  const c1 = shrink(p1, { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 }, 0.35);
  const c2 = shrink(p2, { x: from.x + (2 * (to.x - from.x)) / 3, y: from.y + (2 * (to.y - from.y)) / 3 }, 0.35);
  let down = false;
  try {
    await send(cdp, st, 'touchStart', [pointFor(f, from.x, from.y, rng, 0.7)]);
    down = true;
    await human.sleep(opts.raw ? 0 : human.logNormal(rng, 45, 0.3, 20, 110));       // finger lands, then moves
    const start = timing.now();
    for (let i = 1; i <= n; i++) {
      const tl = i / n;
      const t = human.easeOut(tl);
      const p = human.bezier(from, c1, c2, to, t);
      const shape = 0.9 + 0.35 * Math.sin(Math.PI * tl);               // pressure swells mid-stroke
      await send(cdp, st, 'touchMove', [pointFor(f, p.x + human.gaussian(rng) * 0.25, p.y + human.gaussian(rng) * 0.25, rng, shape)]);
      await timing.preciseSleepUntil(start + i * (duration / n));        // a frame every FRAME_MS, in real time
    }
    await send(cdp, st, 'touchEnd', []);
    down = false;
  } finally {
    if (down) { try { await send(cdp, st, 'touchEnd', []); } catch { /* ignore */ } }
  }
  return { from, to, durationMs: Date.now() - t0 };
}

/**
 * Scroll the page by `dy` CSS px (positive = reveal content further down) with finger drags: what an element that is
 * off-screen needs on a touch-only profile, where a mouse wheel would contradict the fingerprint (see ./modality.js).
 * Each drag covers at most ~55% of the viewport height and ends with the finger slowing to a stop, so no fling
 * carries the page past the target; the caller re-measures and calls again if it is still not in view.
 * @returns {Promise<{swipes:number}>}
 */
async function scrollBy(page, dy, opts = {}) {
  const rng = opts.rng || Math.random;
  const vp = opts.vp || await human.viewportMetrics(page);
  const SLOP = 16;                                   // Chrome's touch slop: the first ~15 px of a drag do not scroll
  let remaining = dy;
  let swipes = 0;
  while (Math.abs(remaining) > 2 && swipes < 8) {
    const chunk = Math.sign(remaining) * Math.min(Math.abs(remaining), vp.height * 0.55);
    const len = Math.abs(chunk) + SLOP;
    const x = vp.width * (0.35 + rng() * 0.3);
    // the finger moves AGAINST the content: content scrolls down (chunk > 0) = finger travels up
    const yStart = chunk > 0 ? vp.height * (0.72 + rng() * 0.08) : vp.height * (0.2 + rng() * 0.08);
    const yEnd = yStart - Math.sign(chunk) * len;
    await swipe(page, { x, y: yStart }, { x: x + (rng() - 0.5) * 24, y: yEnd }, { rng });
    remaining -= chunk;
    swipes++;
    await human.sleep(human.logNormal(rng, 150, 0.35, 60, 420));      // the page settles, the eye catches up
  }
  return { swipes };
}

/**
 * Pinch around (cx, cy) by `scale` (>1 spreads the fingers = zoom in, <1 pinches
 * them together). Two contacts land a few tens of ms apart, move symmetrically with
 * slight rotation and asymmetry, and lift one after the other.
 */
async function pinch(page, cx, cy, scale, opts = {}) {
  const rng = opts.rng || Math.random;
  const t0 = Date.now();
  await assertTouchCapable(page, 2);
  const cdp = await sessionFor(page);
  const st = human.inputState(page);
  const vp = opts.vp || await human.viewportMetrics(page);
  // spans: start/end finger distance, both must fit in the viewport around the centre
  const room = Math.max(40, 2 * Math.min(cx, vp.width - cx, cy, vp.height - cy) - 12);
  let d0 = Math.min(90 + rng() * 60, room);
  let d1 = d0 * scale;
  if (d1 > room) { d1 = room; d0 = d1 / scale; }
  if (d1 < 24) { d1 = 24; d0 = d1 / scale; }
  d0 = Math.min(d0, room);
  const theta0 = (rng() - 0.5) * 1.0;                                  // finger axis angle
  const dTheta = (rng() - 0.5) * 0.25;                                 // slight rotation during the pinch
  const fA = makeFinger(rng), fB = makeFinger(rng);
  const duration = opts.raw ? 120 : human.logNormal(rng, 480, 0.25, 280, 900);
  const n = Math.max(5, Math.round(duration / FRAME_MS));
  const pos = (tl) => {
    const d = d0 + (d1 - d0) * human.easeInOut(tl);
    const th = theta0 + dTheta * tl;
    const hx = (Math.cos(th) * d) / 2, hy = (Math.sin(th) * d) / 2;
    return [{ x: cx - hx + human.gaussian(rng) * 0.3, y: cy - hy + human.gaussian(rng) * 0.3 },
      { x: cx + hx + human.gaussian(rng) * 0.3, y: cy + hy + human.gaussian(rng) * 0.3 }];
  };
  const a0 = pos(0);
  let downA = false, downB = false;
  try {
    await send(cdp, st, 'touchStart', [pointFor(fA, a0[0].x, a0[0].y, rng, 0.8)]);
    downA = true;
    await human.sleep(opts.raw ? 0 : human.logNormal(rng, 28, 0.35, 10, 70));        // the second finger lands a moment later
    await send(cdp, st, 'touchStart', [pointFor(fA, a0[0].x, a0[0].y, rng, 0.8), pointFor(fB, a0[1].x, a0[1].y, rng, 0.8)]);
    downB = true;
    await human.sleep(opts.raw ? 0 : human.logNormal(rng, 40, 0.3, 15, 90));
    const start = timing.now();
    for (let i = 1; i <= n; i++) {
      const tl = i / n;
      const [pa, pb] = pos(tl);
      const shape = 0.9 + 0.3 * Math.sin(Math.PI * tl);
      await send(cdp, st, 'touchMove', [pointFor(fA, pa.x, pa.y, rng, shape), pointFor(fB, pb.x, pb.y, rng, shape)]);
      await timing.preciseSleepUntil(start + i * (duration / n));
    }
    const end = pos(1);
    await send(cdp, st, 'touchEnd', [pointFor(fB, end[1].x, end[1].y, rng, 0.6)]);     // first finger lifts
    downA = false;
    await human.sleep(opts.raw ? 0 : human.logNormal(rng, 22, 0.35, 8, 60));
    await send(cdp, st, 'touchEnd', []);
    downB = false;
  } finally {
    if (downA || downB) { try { await send(cdp, st, 'touchEnd', []); } catch { /* ignore */ } }
  }
  return { center: { x: cx, y: cy }, scale, spanFrom: Math.round(d0), spanTo: Math.round(d1), durationMs: Date.now() - t0 };
}

module.exports = { assertTouchCapable, tap, swipe, pinch, scrollBy };
