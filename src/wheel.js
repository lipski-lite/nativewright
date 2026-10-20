'use strict';

/**
 * Mouse-wheel model: what a physical wheel actually emits, and calibration
 * from a real human.
 *
 * A wheel is quantised. On Windows one notch is deltaY = ±100 (deltaMode 0),
 * a fast flick sends several events a few ms apart (mostly 1 notch each,
 * occasionally 2-3), then the user pauses to read. A wheel cannot produce
 * partial notches, so a requested distance becomes approximate and the caller
 * reports the distance actually moved.
 *
 * `calibrate-wheel` records a few seconds of the human's own wheel and stores
 * a profile (delta histogram, flick-length histogram, intra-/inter-flick gap
 * statistics) in <BASE_HOME>/wheel-calibration.json. The device belongs to the
 * machine, not to a browser profile, so the file is machine-wide. When a HUMAN
 * calibration exists the scroll engine samples from it instead of the default
 * model (profiles from the --simulate test hook are never adopted).
 *
 * Pure functions + one small file store: no browser needed to test the maths.
 *
 * @module wheel
 */

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const CAL_VERSION = 1;
const MIN_EVENTS = 20;          // a calibration with fewer trusted wheel events is rejected
const BURST_GAP_MS = 120;       // wheel events closer than this belong to the same flick
const IDLE_GAP_MS = 4000;       // gaps longer than this are idle time, not rhythm

function calibrationPath() { return path.join(cfg.BASE_HOME, 'wheel-calibration.json'); }

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Windows mouse, 3-lines-per-notch default: 100 per notch. */
const DEFAULT_MODEL = Object.freeze({
  source: 'default',
  quantum: 100,
  // |delta| histogram (value, probability): mostly 1 notch, occasional 2-3 in fast flicks
  deltas: [[100, 0.84], [200, 0.12], [300, 0.04]],
  // events per flick
  burstLen: [[1, 0.30], [2, 0.28], [3, 0.20], [4, 0.12], [5, 0.06], [6, 0.04]],
  intraGap: { median: 24, sigma: 0.3, min: 15, max: 40 },
  interGap: { median: 75, sigma: 0.4, min: 25, max: 250 },
  reading: { chance: 0.05, median: 500, sigma: 0.5, min: 200, max: 1500 },
});

/** Turn a stored profile into a sampling model. */
function modelFromProfile(p) {
  return {
    source: p.source || 'human',
    quantum: p.quantum,
    deltas: p.deltas,
    burstLen: p.burstLen,
    intraGap: p.intraGap,
    interGap: p.interGap,
    // a human's inter-flick gap distribution already contains their reading pauses
    reading: { chance: 0, median: 0, sigma: 0.1, min: 0, max: 0 },
    profile: p,
  };
}

let _cache = { mtimeMs: -1, file: null, model: null };

/**
 * The model scrolling uses: the HUMAN's calibration if a valid one exists, else the default.
 *
 * Only profiles with `source: 'human'` are adopted. `calibrate-wheel --simulate` is a test hook that records
 * our OWN synthetic wheel events; learning from them is circular, so such a profile (or any other source)
 * is ignored here and the default model stays in force.
 */
function activeModel() {
  const file = calibrationPath();
  let st;
  try { st = fs.statSync(file); } catch { _cache = { mtimeMs: -1, file, model: null }; return DEFAULT_MODEL; }
  if (_cache.file === file && _cache.mtimeMs === st.mtimeMs && _cache.model) return _cache.model;
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validProfile(p)) throw new Error('invalid profile');
    if (p.source !== 'human') throw new Error('not a human calibration');
    _cache = { mtimeMs: st.mtimeMs, file, model: modelFromProfile(p) };
    return _cache.model;
  } catch {
    _cache = { mtimeMs: st.mtimeMs, file, model: null };
    return DEFAULT_MODEL;       // a corrupt, simulated or foreign file must never change (or break) scrolling
  }
}

/**
 * Which model is active and what is on disk, for `state` / `status` / `calibrate-wheel`:
 *   { model: 'default' | 'human', calibration: null | { file, source, createdAt, events, quantum, adopted } }
 */
function calibrationStatus() {
  const p = loadProfile();
  const model = activeModel();
  return {
    model: model.source,
    calibration: p ? {
      file: calibrationPath(), source: p.source, createdAt: p.createdAt, events: p.events,
      quantum: p.quantum, adopted: model.source !== 'default',
    } : null,
  };
}

function validProfile(p) {
  return !!p && p.version === CAL_VERSION && p.deltaMode === 0 && Number.isFinite(p.quantum) && p.quantum > 0
    && Array.isArray(p.deltas) && p.deltas.length > 0 && Array.isArray(p.burstLen) && p.burstLen.length > 0
    && p.intraGap && Number.isFinite(p.intraGap.median) && p.interGap && Number.isFinite(p.interGap.median);
}

function loadProfile() {
  try { const p = JSON.parse(fs.readFileSync(calibrationPath(), 'utf8')); return validProfile(p) ? p : null; }
  catch { return null; }
}

function saveProfile(profile) {
  const file = calibrationPath();
  cfg.ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
  fs.renameSync(tmp, file);
  _cache = { mtimeMs: -1, file: null, model: null };
  return file;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function sampleHist(hist, rng) {
  let r = rng();
  for (const [v, p] of hist) { r -= p; if (r <= 0) return v; }
  return hist[hist.length - 1][0];
}

function clampLogNormal(u, rng, g) {
  return u.logNormal(rng, Math.max(1, g.median), Math.max(0.05, g.sigma), g.min, g.max);
}

/**
 * Stateful generator of wheel events for one scroll gesture.
 * `next(remainingPx)` returns { delta (>0 magnitude), gapMs (pause AFTER this
 * event), endOfFlick }. When `remainingPx` is given the delta is trimmed so a
 * quantised wheel lands as close to the request as it can.
 */
function makePlayer(model, rng, u) {
  let left = 0, idx = 0, size = 0;
  const q = model.quantum;
  return {
    model,
    next(remainingPx) {
      if (left === 0) { size = sampleHist(model.burstLen, rng); left = size; idx = 0; }
      let delta;
      if (model.source === 'default') {
        // single notches, with the occasional multi-notch event only inside longer (faster) flicks
        delta = size >= 3 && idx > 0 ? sampleHist(model.deltas, rng) : q;
      } else {
        delta = sampleHist(model.deltas, rng);
      }
      if (remainingPx != null && delta > remainingPx + q / 2) delta = Math.max(q, Math.round(remainingPx / q) * q);
      idx += 1; left -= 1;
      let gapMs;
      const endOfFlick = left === 0;
      if (!endOfFlick) gapMs = clampLogNormal(u, rng, model.intraGap);
      else {
        gapMs = clampLogNormal(u, rng, model.interGap);
        const rd = model.reading;
        if (rd && rd.chance > 0 && rng() < rd.chance) gapMs += u.logNormal(rng, rd.median, rd.sigma, rd.min, rd.max);
      }
      return { delta, gapMs, endOfFlick };
    },
  };
}

/** The events a quantised wheel would send to cover `targetPx` (>= 1 notch for any non-zero request). */
function plan(model, rng, u, targetPx) {
  const target = Math.abs(targetPx);
  const out = [];
  if (!(target > 0)) return out;
  const p = makePlayer(model, rng, u);
  let sum = 0;
  while (out.length === 0 || sum < target - model.quantum / 2) {
    const e = p.next(target - sum);
    out.push(e);
    sum += e.delta;
    if (out.length > 5000) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calibration: raw trusted wheel events -> profile
// ---------------------------------------------------------------------------

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function fitLogNormal(values, fallback) {
  const xs = values.filter((v) => v > 0);
  if (xs.length < 5) return { ...fallback, n: xs.length, fallback: true };
  const logs = xs.map((v) => Math.log(Math.max(v, 1)));
  const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mu) ** 2, 0) / logs.length);
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    median: Math.round(Math.exp(mu) * 10) / 10,
    sigma: Math.round(Math.max(0.08, sd) * 1000) / 1000,
    min: Math.round(percentile(sorted, 0.02) * 10) / 10,
    max: Math.round(percentile(sorted, 0.98) * 10) / 10,
    n: xs.length,
  };
}

function histogram(values, keep) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, keep);
  const total = entries.reduce((a, [, c]) => a + c, 0);
  return entries.sort((a, b) => a[0] - b[0]).map(([v, c]) => [v, Math.round((c / total) * 1000) / 1000]);
}

/**
 * Derive a calibration profile from raw wheel events.
 * @param {{t:number,dx:number,dy:number,mode:number}[]} events  `t` in milliseconds
 * @param {object} meta  { source, dpr, platform, ... }
 * @throws if fewer than MIN_EVENTS usable events were recorded
 */
function deriveProfile(events, meta = {}) {
  const px = events.filter((e) => e.mode === 0 && (e.dx || e.dy));
  const ignoredNonPixel = events.filter((e) => e.mode !== 0).length;
  if (px.length < MIN_EVENTS) {
    const err = new Error(
      `calibration rejected: only ${px.length} usable wheel event(s) recorded (need at least ${MIN_EVENTS}). ` +
      'Scroll with your own mouse wheel for the whole duration, in several short flicks, then run calibrate-wheel again.' +
      (ignoredNonPixel ? ` (${ignoredNonPixel} event(s) used a non-pixel deltaMode and were ignored.)` : ''));
    err.code = 'TOO_FEW_EVENTS';
    err.events = px.length;
    throw err;
  }
  px.sort((a, b) => a.t - b.t);
  const mags = px.map((e) => Math.round(Math.max(Math.abs(e.dx), Math.abs(e.dy)) * 100) / 100);
  const deltas = histogram(mags, 10);
  // quantum: the most frequent magnitude (smallest on ties)
  const counts = new Map();
  for (const m of mags) counts.set(m, (counts.get(m) || 0) + 1);
  let quantum = mags[0], best = -1;
  for (const [v, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) if (c > best) { best = c; quantum = v; }

  const bursts = [];
  const intra = [], inter = [];
  let cur = 1;
  for (let i = 1; i < px.length; i++) {
    const gap = px[i].t - px[i - 1].t;
    if (gap <= BURST_GAP_MS) { intra.push(gap); cur += 1; }
    else {
      bursts.push(cur); cur = 1;
      if (gap <= IDLE_GAP_MS) inter.push(gap);
    }
  }
  bursts.push(cur);
  const burstLen = histogram(bursts.map((n) => Math.min(n, 12)), 12);

  const quantised = best / mags.length >= 0.5;       // one value dominates -> a notched wheel; else smooth (trackpad-like)
  return {
    version: CAL_VERSION,
    source: meta.source || 'human',
    createdAt: new Date().toISOString(),
    events: px.length,
    ignoredNonPixel,
    deltaMode: 0,
    quantum,
    quantised,
    deltas,
    bursts: bursts.length,
    burstLen,
    intraGap: fitLogNormal(intra, DEFAULT_MODEL.intraGap),
    interGap: fitLogNormal(inter, DEFAULT_MODEL.interGap),
    axes: {
      y: px.filter((e) => Math.abs(e.dy) >= Math.abs(e.dx)).length,
      x: px.filter((e) => Math.abs(e.dx) > Math.abs(e.dy)).length,
    },
    dpr: meta.dpr || null,
    platform: meta.platform || process.platform,
  };
}

module.exports = {
  CAL_VERSION, MIN_EVENTS, BURST_GAP_MS, DEFAULT_MODEL,
  calibrationPath, activeModel, calibrationStatus, loadProfile, saveProfile, validProfile, modelFromProfile,
  makePlayer, plan, deriveProfile,
};
