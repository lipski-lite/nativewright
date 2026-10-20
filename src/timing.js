'use strict';

/**
 * Time, for the human-input layer: a sleep that is as accurate as the hardware's
 * own timing, and an event clock that stays in step with the browser's.
 *
 * WHY. Node's setTimeout rides the OS timer tick: ~15.6 ms on Windows, so
 * sleep(1..15) ends after 15.6 ms, sleep(17..31) after 31 ms, sleep(33..46)
 * after 46.5 ms, and so on. Every click dwell, key gap and wheel gap the page
 * observed was a multiple of that tick (measured: 86% of click dwells within
 * +-1 ms of the 15.625 ms lattice; real discrete input shows no such lattice),
 * and a key-up stamped "key-down + dwell" but dispatched at the next tick
 * reached the page up to 16 ms late. preciseSleep() fixes the first, and the
 * callers stop stamping discrete events themselves (Chrome stamps them at
 * dispatch, like real input), which fixes the second.
 *
 * preciseSleep: a timer for the bulk of the wait (all but the last tick and 1 ms),
 * then a NON-BLOCKING spin on setImmediate until performance.now() reaches the
 * target. Never a synchronous busy loop: several pages share one daemon event
 * loop, and every other page's I/O keeps being served between the spin's turns.
 *
 * Event clock: coalesced pointer sub-samples are the one place that carries an
 * explicit CDP timestamp. Chrome converts a Unix-epoch timestamp with an offset
 * it freezes ONCE per browser process, so stamps derived from Date.now() (1 ms
 * truncation jitter; slewed or stepped by time sync and by resume) drift away
 * from Chrome's clock over uptime. nowSec() is a monotonic clock anchored to the
 * wall clock at one instant, and pinClock() makes Chrome freeze its offset at that
 * same instant.
 *
 * @module timing
 */

const { performance } = require('perf_hooks');

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

// Test hook (human.sanity.js): in virtual time nothing waits for real; a sleep just advances the clock.
let virtual = null;

/** Milliseconds on the monotonic clock (virtual in tests). */
function now() { return virtual ? virtual.ms : performance.now(); }

// ---------------------------------------------------------------------------
// timer granularity
// ---------------------------------------------------------------------------

// Until measured: a Windows timer tick is ~15.6 ms, elsewhere ~1 ms (rounded up).
let granularityMs = process.platform === 'win32' ? 16 : 2;

/** The timer granularity in force (ms): measured by measureGranularity(), else the platform default. */
function granularity() { return granularityMs; }

/** Override the granularity (tests). */
function setGranularity(ms) { if (Number.isFinite(ms) && ms >= 0) granularityMs = ms; }

/**
 * Measure the timer granularity: the upper quartile of the gaps of consecutive setTimeout(1).
 * Meant to run once, in the background, at daemon start.
 *
 * Not the median: what preciseSleep needs is how late a timer can be (up to one tick), and the daemon starts the browser at
 * the same moment, whose I/O wakes the event loop between ticks, so many of the first gaps are short. Measured on this
 * Windows machine (tick 15.5 ms) over six launches: the median was 6.5-15.5 ms (a daemon logged 11 and 11.5), the upper
 * quartile 15.5 ms every time. With 11.5 assumed, ~15% of the sleeps ended up to ~1.1 ms late (g=16: never more than 0.2 ms).
 * @returns {Promise<number>} the granularity now in force
 */
async function measureGranularity(samples = 15) {
  if (virtual) return granularityMs;
  const gaps = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1));
    gaps.push(performance.now() - t0);
  }
  granularityMs = granularityFromGaps(gaps, granularityMs);
  return granularityMs;
}

/** The granularity to assume from consecutive setTimeout(1) gaps (ms): their upper quartile, up to the next half ms, within 1..25. */
function granularityFromGaps(gaps, fallback = granularityMs) {
  const sorted = gaps.filter((g) => Number.isFinite(g)).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)];
  return Math.min(25, Math.max(1, Math.ceil(q3 * 2) / 2));
}

// ---------------------------------------------------------------------------
// sleeping
// ---------------------------------------------------------------------------

/** Wait until the monotonic clock (now()) reaches `target` ms: a timer for the bulk, a cooperative spin for the tail. */
function preciseSleepUntil(target) {
  if (virtual) {
    if (target > virtual.ms) virtual.ms = target;
    return Promise.resolve();
  }
  const remaining = target - performance.now();
  if (!(remaining > 0)) return Promise.resolve();
  const spin = () => new Promise((resolve) => {
    const tick = () => { if (performance.now() >= target) resolve(); else setImmediate(tick); };
    tick();
  });
  // a timer fires between its delay and one tick after it: stop >= 1 ms short of the target
  const bulk = Math.floor(remaining - granularityMs - 1);
  if (bulk > 0) return new Promise((resolve) => setTimeout(resolve, bulk)).then(spin);
  return spin();
}

/** Sleep `ms` (fractions kept) with sub-millisecond accuracy. Use before anything that ends in an input event. */
function preciseSleep(ms) {
  const n = Number(ms);
  return preciseSleepUntil(now() + (n > 0 ? n : 0));
}

/**
 * Plain setTimeout: for internal polling that does not end in an input event (waiting on page state, overlay refresh,
 * verify loops). Cheaper than preciseSleep (no spin); it rounds up to the timer tick.
 */
function coarseSleep(ms) {
  const n = Number(ms);
  const wait = n > 0 ? n : 0;
  if (virtual) { virtual.ms += wait; return Promise.resolve(); }
  return new Promise((resolve) => setTimeout(resolve, Math.round(wait)));
}

// ---------------------------------------------------------------------------
// event clock
// ---------------------------------------------------------------------------

let anchor = { wall: Date.now(), mono: now() };

/** Take a new anchor: the wall clock and the monotonic clock read at the same instant. */
function reanchor() { anchor = { wall: Date.now(), mono: now() }; }

/** Seconds since the Unix epoch on the anchored monotonic clock: what a CDP `timestamp` expects. */
function nowSec() { return (anchor.wall + (now() - anchor.mono)) / 1000; }

/**
 * Pin the browser's clock offset to ours. Re-anchors, then at once dispatches ONE timestamped mouse event so Chrome
 * freezes its Unix-epoch -> TimeTicks offset at the same instant. Send it on a page of the daemon's own (never a
 * website's): a mouseMoved to (0, 0) with no button is harmless there.
 * @param {{send: function}} cdp a CDP session of that page
 * @returns {Promise<number>} the timestamp (seconds) that was sent
 */
async function pinClock(cdp) {
  reanchor();
  const timestamp = nowSec();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0, button: 'none', timestamp });
  return timestamp;
}

/** Test hook: virtual time (a sleep advances the clock instead of waiting) on/off. */
function _useVirtualClock(on) {
  if (on) { virtual = { ms: performance.now() }; reanchor(); }
  else { virtual = null; reanchor(); }
}

module.exports = {
  now, granularity, setGranularity, measureGranularity, granularityFromGaps,
  preciseSleep, preciseSleepUntil, coarseSleep,
  reanchor, nowSec, pinClock,
  _useVirtualClock,
};
