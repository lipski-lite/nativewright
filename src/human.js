'use strict';

// Human-behavior primitives used by the daemon to make every mouse / keyboard
// action look like a real person. Applied by default to click/type/hover/fill/
// scroll/press — callers opt out with raw:true when they truly need robotic
// precision (e.g. invisible elements, programmatic fills).
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
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
// Mouse primitives — operate on a Playwright Page
// --------------------------------------------------------------------------

// Track the mouse's logical position because Playwright's mouse object is
// stateless between moves. The first move of a daemon lifetime starts from
// a random on-screen point (not 0,0, which is bot-telltale).
const MOUSE_POS = new WeakMap();

function getPos(page, rng) {
  let p = MOUSE_POS.get(page);
  if (p) return p;
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  p = {
    x: Math.round(vp.width * (0.2 + 0.6 * rng())),
    y: Math.round(vp.height * (0.2 + 0.6 * rng())),
  };
  MOUSE_POS.set(page, p);
  return p;
}

function setPos(page, p) {
  MOUSE_POS.set(page, { x: p.x, y: p.y });
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
// realistic distinct `timeStamp`s instead of OS-timer-quantized ones — the
// timestamps we pass are not subject to Windows' 15.6ms setTimeout lattice).
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
// samples, like real hardware). Sub-sample timestamps are anchored to
// wall-clock at dispatch and spaced by the simulated polling interval, ending
// at ≈ now so the page never sees events dated in the future.
async function dispatchFrameBurst(cdp, prev, p, frameDurMs, rng, buttons) {
  const segLen = dist(prev, p);
  let k = Math.max(1, Math.min(7, Math.round(segLen / 5)));
  if (k > 2 && rng() < 0.3) k -= 1;              // jitter count; keep slow segs low
  const pollSec = (frameDurMs / k) / 1000;
  const now = Date.now() / 1000;
  const subs = [];
  for (let j = 0; j < k; j++) {
    const f = (j + 1) / k;
    subs.push({
      x: Math.round(prev.x + (p.x - prev.x) * f),
      y: Math.round(prev.y + (p.y - prev.y) * f),
      ts: now - (k - 1 - j) * pollSec,           // monotonic; last ≈ now
    });
  }
  await Promise.all(subs.map((s) => cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: s.x, y: s.y, button: 'none', buttons: buttons || 0,
    timestamp: s.ts,
  })));
}

// Walk a sampled path: one dispatched `pointermove` per point, sleeping
// `perStepMs` (jittered) between points. Uses coalesced CDP bursts when a
// session is available, else classic awaited single moves. Returns final pos.
async function traversePath(page, cdp, fromPoint, path, perStepMs, rng, buttons) {
  let prev = { x: fromPoint.x, y: fromPoint.y };
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const frameDur = perStepMs * (1 + (rng() - 0.5) * 0.5);
    if (cdp) {
      try { await dispatchFrameBurst(cdp, prev, p, frameDur, rng, buttons); }
      catch { await page.mouse.move(p.x, p.y, { steps: 1 }); }
    } else {
      await page.mouse.move(p.x, p.y, { steps: 1 });
    }
    // hesitation samples carry their own extra pause; others use perStep
    await sleep((p.pauseMs || 0) + frameDur);
    prev = { x: p.x, y: p.y };
  }
  return prev;
}

// Move the mouse along a natural path to (x,y). `targetW` is the effective
// size of the target (used for Fitts timing); pass the bbox width when
// moving toward an element.
async function moveTo(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  const from = getPos(page, rng);
  const to = { x, y };
  const d = dist(from, to);

  // Even when already at (or near) target, emit a small idle jitter so
  // repeat-clicks don't produce an empty-move signature. Cheap and cheap
  // to skip in raw mode (callers don't call moveTo there).
  if (d < 2) {
    const j = 1 + rng() * 3;
    const ang = rng() * Math.PI * 2;
    const jitterTo = { x: from.x + Math.cos(ang) * j, y: from.y + Math.sin(ang) * j };
    await page.mouse.move(jitterTo.x, jitterTo.y, { steps: 1 });
    await sleep(20 + rng() * 40);
    await page.mouse.move(to.x, to.y, { steps: 1 });
    setPos(page, to);
    return;
  }

  const cdp = await getCdpSession(page);
  const durationMs = moveDurationMs(d, opts.targetW || 20, rng);

  // Optional overshoot: for longer moves, ~20% chance to overshoot the
  // target slightly then correct back. Never overshoot tiny targets.
  const doOvershoot = d > 120 && opts.targetW > 12 && rng() < 0.2;
  let primaryTarget = to;
  let overshootPoint = null;
  if (doOvershoot) {
    const overshootMag = 6 + rng() * 18;
    const dx = (to.x - from.x) / d, dy = (to.y - from.y) / d;
    overshootPoint = {
      x: to.x + dx * overshootMag + (rng() - 0.5) * 4,
      y: to.y + dy * overshootMag + (rng() - 0.5) * 4,
    };
    primaryTarget = overshootPoint;
  }

  const { path, steps } = samplePath(from, primaryTarget, rng);
  await traversePath(page, cdp, from, path, durationMs / steps, rng, 0);

  if (overshootPoint) {
    setPos(page, overshootPoint);
    const { path: corr } = samplePath(overshootPoint, to, rng, { easing: easeOut });
    const corrDur = logNormal(rng, 90, 0.25, 60, 220);
    await traversePath(page, cdp, overshootPoint, corr, corrDur / corr.length, rng, 0);
  }

  // Sync Playwright's own mouse position to the final target: the CDP burst
  // path bypasses Playwright's internal mouse state, so a subsequent
  // page.mouse.down()/up() (the click) must be re-anchored here or it would
  // fire at a stale coordinate. The cursor is already at `to` (CDP moved it),
  // so this trailing move dispatches a harmless final settle sample.
  try { await page.mouse.move(to.x, to.y, { steps: 1 }); } catch { /* ignore */ }
  setPos(page, to);
}

async function clickAt(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  await moveTo(page, x, y, opts);
  // tiny settle pause before button press — humans don't click the instant
  // the cursor stops
  await sleep(logNormal(rng, 55, 0.3, 20, 180));
  await page.mouse.down({ button: opts.button || 'left' });
  // dwell time mousedown→mouseup
  await sleep(logNormal(rng, 70, 0.3, 30, 180));
  await page.mouse.up({ button: opts.button || 'left' });
}

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

// --------------------------------------------------------------------------
// High-level operations on a Locator
// --------------------------------------------------------------------------

async function resolveBox(locator, timeoutMs, opts = {}) {
  const page = opts.page;
  const rng  = opts.rng || Math.random;
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });

  // If we have a page handle and the element is off-screen, scroll via real
  // wheel events toward it. Fall back to scrollIntoViewIfNeeded after the
  // wheel pass closes most of the distance.
  if (page) {
    try {
      let box = await locator.boundingBox({ timeout: timeoutMs });
      if (box) {
        const vp = page.viewportSize() || { width: 1280, height: 800 };
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
          await humanScroll(page, wheelDelta, { rng });
        }
      }
    } catch { /* fall through to scrollIntoViewIfNeeded */ }
  }

  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
  const box = await locator.boundingBox({ timeout: timeoutMs });
  if (!box) throw new Error('element has no bounding box (detached or 0-size)');
  return box;
}

async function humanClick(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const button = opts.button || 'left';
  const clickCount = opts.clickCount || 1;
  const t0 = Date.now();
  const box = await resolveBox(locator, timeout, { page, rng });
  const target = pointInBox(box, rng);
  const tMoveStart = Date.now();
  await moveTo(page, target.x, target.y, {
    rng, targetW: Math.min(box.width, box.height),
  });
  await sleep(logNormal(rng, 55, 0.3, 20, 180));
  for (let i = 0; i < clickCount; i++) {
    await page.mouse.down({ button });
    await sleep(logNormal(rng, 70, 0.3, 30, 180));
    await page.mouse.up({ button });
    if (i + 1 < clickCount) {
      await sleep(logNormal(rng, 110, 0.25, 60, 220));
    }
  }
  return {
    landedAt: { x: Math.round(target.x), y: Math.round(target.y) },
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
  const target = pointInBox(box, rng);
  await moveTo(page, target.x, target.y, {
    rng,
    targetW: Math.min(box.width, box.height),
  });
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
  if (/[A-Z]/.test(ch)) return 150;               // Shift hold
  if (/[a-z]/.test(ch)) return 95;
  return 140;                                      // symbols and other
}

// Adjacent-key typo map for QWERTY — what a real finger might hit instead
// of the intended key. Only lowercase; uppercase maps inherited via Shift
// at typing time.
const NEIGHBOR_KEY = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'rygf',
  y: 'tuhg', u: 'yijh', i: 'uojk', o: 'ipkl', p: 'ol',
  a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv',
  h: 'gyujnb', j: 'huiknm', k: 'jiolm', l: 'kop', z: 'asx',
  x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  ' ': 'bnvcxm',
};

function pickTypo(ch, rng) {
  const lower = ch.toLowerCase();
  const nbrs = NEIGHBOR_KEY[lower];
  if (!nbrs) return null;
  const wrong = nbrs[Math.floor(rng() * nbrs.length)];
  return ch === ch.toUpperCase() && ch !== lower ? wrong.toUpperCase() : wrong;
}

// --- physical-key descriptors for CDP Input.dispatchKeyEvent ---------------
// We emit keystrokes via raw CDP keyed on the PHYSICAL code so we can wrap
// shifted characters in explicit ShiftLeft keydown/keyup events. The old path
// (`page.keyboard.press('A')`) produced a capital with NO Shift key event in
// the stream at all — a physically-impossible signature any keystroke-dynamics
// model flags instantly. Keying on `code` (not the char) also avoids
// Playwright re-resolving Shift and re-introducing the bug.
function buildKeyMap() {
  const m = {};
  const add = (ch, code, vk, shift) => { m[ch] = { code, vk, key: ch, text: ch, shift: !!shift }; };
  for (let i = 0; i < 26; i++) {
    const lo = String.fromCharCode(97 + i), up = String.fromCharCode(65 + i);
    add(lo, 'Key' + up, 65 + i, false);
    add(up, 'Key' + up, 65 + i, true);
  }
  const sh = ')!@#$%^&*(';
  for (let d = 0; d < 10; d++) {
    add(String(d), 'Digit' + d, 48 + d, false);
    add(sh[d], 'Digit' + d, 48 + d, true);
  }
  add(' ', 'Space', 32, false);
  const punct = [
    ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
    ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
    [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
    ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
  ];
  for (const [lo, hi, code, vk] of punct) { add(lo, code, vk, false); add(hi, code, vk, true); }
  return m;
}
const KEYMAP = buildKeyMap();
const SHIFT_DESC = { code: 'ShiftLeft', vk: 16, key: 'Shift' };          // no text
const BACKSPACE_DESC = { code: 'Backspace', vk: 8, key: 'Backspace' };   // no text

async function dispatchKey(cdp, desc, type, shiftActive, ts) {
  const ev = {
    type,
    windowsVirtualKeyCode: desc.vk,
    code: desc.code,
    key: desc.key,
    modifiers: shiftActive ? 8 : 0,   // 8 = Shift
  };
  if (ts != null) ev.timestamp = ts;
  if (type === 'keyDown' && desc.text) ev.text = desc.text;
  await cdp.send('Input.dispatchKeyEvent', ev);
}

// Emit a single key as down → (precise dwell) → up. The dwell the page observes
// is encoded in the keyUp `timestamp` (keyDown base + exact dwell), so it is a
// continuous value rather than one snapped to Windows' 15.6ms setTimeout tick —
// the wall-clock sleep used for pacing may quantize, but the page never sees it.
async function emitKey(cdp, desc, dwellMs, shiftActive) {
  const base = Date.now() / 1000;
  await dispatchKey(cdp, desc, 'keyDown', shiftActive, base);
  await sleep(dwellMs);
  await dispatchKey(cdp, desc, 'keyUp', shiftActive, base + dwellMs / 1000);
}

// Emit a printable char, managing the Shift run: Shift is pressed slightly
// before the first shifted char and held across consecutive shifted chars
// (as a real typist does), released when a non-shifted char arrives.
async function emitChar(cdp, desc, dwellMs, state, rng) {
  if (desc.shift && !state.shift) {
    await dispatchKey(cdp, SHIFT_DESC, 'keyDown', true, Date.now() / 1000);
    state.shift = true;
    await sleep(logNormal(rng, 55, 0.35, 20, 160));   // shift lead
  } else if (!desc.shift && state.shift) {
    await dispatchKey(cdp, SHIFT_DESC, 'keyUp', false, Date.now() / 1000);
    state.shift = false;
    await sleep(logNormal(rng, 45, 0.35, 15, 140));
  }
  await emitKey(cdp, desc, dwellMs, state.shift);
}

// Legacy fallback (only if a CDP session can't be created): the original
// press-based path. Retains the Shift-event gap but keeps the tool functional
// in environments without CDP.
async function legacyType(page, text, rng, typosEnabled) {
  let prev = '';
  let burst = 1.0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const base = charBaseMs(ch);
    if (/[a-z]/.test(ch)) burst = Math.max(0.65, burst * (rng() < 0.3 ? 0.9 : 1.0));
    else burst = Math.min(1.15, burst + 0.05);
    let delay = logNormal(rng, base * burst, 0.35, 30, 500);
    if (prev === ' ' && ch !== ' ') delay += logNormal(rng, 80, 0.4, 20, 300);
    if (/[.,;:!?]/.test(prev)) delay += logNormal(rng, 120, 0.4, 30, 450);
    if (i > 1 && rng() < 0.015) delay += logNormal(rng, 650, 0.5, 200, 2200);
    await sleep(delay);
    const wrong = typosEnabled && i > 0 && rng() < 0.008 ? pickTypo(ch, rng) : null;
    if (wrong) {
      await page.keyboard.press(wrong, { delay: Math.round(logNormal(rng, 55, 0.3, 20, 130)) });
      await sleep(logNormal(rng, 220, 0.4, 90, 700));
      await page.keyboard.press('Backspace', { delay: Math.round(logNormal(rng, 45, 0.3, 20, 110)) });
      await sleep(logNormal(rng, 140, 0.3, 60, 400));
    }
    await page.keyboard.press(ch, { delay: Math.round(logNormal(rng, 55, 0.3, 20, 130)) });
    prev = ch;
  }
}

// Type a string one char at a time with realistic inter-key gaps, per-key
// dwell, burstiness, explicit Shift handling, and optional typo-then-correct
// patterns. `opts.typos`:
//   'off'  — never insert typos (use for passwords, credentials)
//   'on'   — ~0.8% per char
//   'auto' — default; detects password fields and disables typos for them
async function humanType(page, text, opts = {}) {
  const rng = opts.rng || Math.random;
  const typosMode = opts.typos || 'auto';
  let typosEnabled = typosMode === 'on';
  if (typosMode === 'auto') {
    // cheap heuristic: check the currently-focused element's type. If it
    // looks like a password/code/OTP field, disable typos.
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

  const state = { shift: false };
  let prev = '';
  let burst = 1.0;
  try {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const desc = KEYMAP[ch];
      const base = charBaseMs(ch);

      if (/[a-z]/.test(ch)) burst = Math.max(0.65, burst * (rng() < 0.3 ? 0.9 : 1.0));
      else burst = Math.min(1.15, burst + 0.05);

      let delay = logNormal(rng, base * burst, 0.35, 30, 500);
      if (prev === ' ' && ch !== ' ') delay += logNormal(rng, 80, 0.4, 20, 300);
      if (/[.,;:!?]/.test(prev)) delay += logNormal(rng, 120, 0.4, 30, 450);
      if (i > 1 && rng() < 0.015) delay += logNormal(rng, 650, 0.5, 200, 2200);
      await sleep(delay);

      // char not in the physical-key map (emoji, accented letters, CJK):
      // release any held Shift and fall back to Playwright's press for it.
      if (!desc) {
        if (state.shift) { await dispatchKey(cdp, SHIFT_DESC, 'keyUp', false, Date.now() / 1000); state.shift = false; }
        await page.keyboard.press(ch, { delay: Math.round(logNormal(rng, 55, 0.3, 20, 130)) });
        prev = ch;
        continue;
      }

      // typo: emit a wrong neighbour, notice, Backspace, then the real char.
      const wrongCh = typosEnabled && i > 0 && rng() < 0.008 ? pickTypo(ch, rng) : null;
      const wrongDesc = wrongCh ? KEYMAP[wrongCh] : null;
      if (wrongDesc) {
        await emitChar(cdp, wrongDesc, logNormal(rng, 60, 0.3, 25, 140), state, rng);
        await sleep(logNormal(rng, 220, 0.4, 90, 700));                 // "noticing" pause
        await emitKey(cdp, BACKSPACE_DESC, logNormal(rng, 50, 0.3, 20, 120), state.shift);
        await sleep(logNormal(rng, 140, 0.3, 60, 400));
      }

      await emitChar(cdp, desc, logNormal(rng, 62, 0.3, 25, 140), state, rng);
      prev = ch;
    }
  } finally {
    // never leave Shift logically stuck, even if something threw mid-string
    if (state.shift) {
      try { await dispatchKey(cdp, SHIFT_DESC, 'keyUp', false, Date.now() / 1000); } catch { /* ignore */ }
      state.shift = false;
    }
  }
}

// --------------------------------------------------------------------------
// Scroll
// --------------------------------------------------------------------------

// Roll the wheel in a series of discrete ticks with variable delta and gaps.
// Net scroll total ≈ totalPx, sign indicates direction. Stops early when the
// page can no longer scroll (avoids infinite wheeling on short pages).
async function humanScroll(page, totalPx, opts = {}) {
  const rng = opts.rng || Math.random;
  const sign = totalPx >= 0 ? 1 : -1;
  const remaining = { v: Math.abs(totalPx) };
  const maxTicks = 400; // hard safety ceiling

  let lastY = await page.evaluate(() => window.scrollY).catch(() => null);
  let stuckTicks = 0;

  for (let i = 0; i < maxTicks && remaining.v > 0; i++) {
    let tick = Math.round(60 + rng() * 120);
    if (rng() < 0.08) tick = Math.round(180 + rng() * 160);
    tick = Math.min(tick, remaining.v);
    await page.mouse.wheel(0, sign * tick);
    remaining.v -= tick;

    // inter-tick gap: log-normal around 70ms, occasional longer "reading" pause
    let gap = logNormal(rng, 75, 0.4, 25, 250);
    if (rng() < 0.05) gap += logNormal(rng, 500, 0.5, 200, 1500);
    await sleep(gap);

    // Detect "stuck at edge": if window.scrollY didn't change after 2
    // consecutive ticks, stop. Falls back silently if scrollY read fails
    // (e.g. cross-origin, or page navigating).
    try {
      const y = await page.evaluate(() => window.scrollY);
      if (lastY != null && Math.abs(y - lastY) < 1) {
        stuckTicks += 1;
        if (stuckTicks >= 2) break;
      } else {
        stuckTicks = 0;
      }
      lastY = y;
    } catch { /* keep going */ }
  }
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
// signature). Whatever the gesture, we always finish with Ctrl+A before the
// delete key so the field is reliably emptied for inputs, multi-line
// textareas, and React-controlled contenteditables alike.
async function humanClearField(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const box = await resolveBox(locator, timeout, { page, rng });
  const target = pointInBox(box, rng);
  await moveTo(page, target.x, target.y, {
    rng, targetW: Math.min(box.width, box.height),
  });
  await sleep(logNormal(rng, 50, 0.3, 20, 150));

  // Pick how many times to click before the select-all: triple (select line),
  // double (select word), single (just focus/caret), or none (move only).
  const r = rng();
  const clicks = r < 0.5 ? 3 : r < 0.75 ? 1 : r < 0.92 ? 2 : 0;
  for (let i = 0; i < clicks; i++) {
    await page.mouse.down(); await sleep(logNormal(rng, 40, 0.25, 15, 100));
    await page.mouse.up();
    if (i + 1 < clicks) await sleep(logNormal(rng, 70, 0.25, 30, 150));
  }
  await sleep(logNormal(rng, 80, 0.3, 30, 180));

  // Reliable select-all, then a delete key chosen at random (Delete vs
  // Backspace — both empty a fully-selected field; real users use either).
  await page.keyboard.press('Control+A', { delay: Math.round(logNormal(rng, 50, 0.2, 25, 100)) });
  await sleep(logNormal(rng, 70, 0.3, 25, 180));
  const delKey = rng() < 0.5 ? 'Delete' : 'Backspace';
  await page.keyboard.press(delKey, { delay: Math.round(logNormal(rng, 55, 0.25, 25, 120)) });
}

// --------------------------------------------------------------------------

module.exports = {
  makeRng,
  gaussian, logNormal, sleep,
  bezier, buildControlPoints, samplePath, easeInOut, easeOut, easeLinearish,
  moveDurationMs,
  getPos, setPos, moveTo, clickAt,
  pointInBox, resolveBox,
  humanClick, humanHover, humanType, humanScroll, humanClearField,
  think, thinkMs, charBaseMs,
};
