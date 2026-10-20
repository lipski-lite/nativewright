'use strict';

/**
 * Drop OS files onto a page the way a person drags them in from the file
 * manager: the drag ENTERS from the window edge nearest the target, travels
 * along a human path while the page receives frame-paced `dragover`s, settles
 * briefly over the target, and drops.
 *
 * Mechanism: CDP Input.dispatchDragEvent with
 *   data: { items: [], files: [<absolute paths>], dragOperationsMask: 19 }
 * which produces TRUSTED dragenter/dragover/drop events whose DataTransfer
 * carries real File objects (name, size, type, content) - verified headed and
 * headless. Dropping onto an <input type=file> sets its files and fires
 * `change`.
 *
 * The mask is what a file manager offers: Copy 1 | Link 2 | Move 16 = 19, which a
 * page sees as dataTransfer.effectAllowed 'all'. (Measured: mask 1 gave 'copy', and
 * then a page that answers with dropEffect = 'move' gets no drop at all.)
 *
 * Every point sits on the device-pixel grid (human.q), like the pointer's.
 *
 * @module filedrop
 */

const fs = require('fs');
const path = require('path');
const human = require('./human');
const timing = require('./timing');

// Copy 1 | Link 2 | Move 16: what a file manager's drag offers.
const DRAG_OPERATIONS_MASK = 1 | 2 | 16;

/**
 * Resolve and verify the paths against the caller's cwd.
 * @returns {{path:string,name:string,size:number}[]}
 */
function resolveFiles(paths, cwd) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => p != null && p !== '').map(String);
  if (list.length === 0) throw new Error('at least one file path required (drop-files <selector> <path> [<path>...])');
  return list.map((p) => {
    const abs = path.resolve(cwd || process.cwd(), p);
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`file not found: ${abs}`); }
    if (!st.isFile()) throw new Error(`not a file (directories cannot be dropped): ${abs}`);
    try { fs.accessSync(abs, fs.constants.R_OK); } catch { throw new Error(`file is not readable: ${abs}`); }
    return { path: abs, name: path.basename(abs), size: st.size };
  });
}

/** A point just inside the viewport edge nearest the target, slid along the edge a little. */
function entryPoint(target, vp, rng) {
  const dl = target.x, dr = vp.width - target.x, dt = target.y, db = vp.height - target.y;
  const m = Math.min(dl, dr, dt, db);
  const slide = (rng() - 0.5) * 60;
  const inset = 2 + rng() * 2;
  const clamp = (v, hi) => Math.max(1, Math.min(hi - 1, v));
  if (m === dl) return { x: inset, y: clamp(target.y + slide, vp.height) };
  if (m === dr) return { x: vp.width - inset, y: clamp(target.y + slide, vp.height) };
  if (m === dt) return { x: clamp(target.x + slide, vp.width), y: inset };
  return { x: clamp(target.x + slide, vp.width), y: vp.height - inset };
}

/**
 * Drag `files` in from the nearest window edge and drop them at `target`
 * (viewport CSS px).
 * @param {{path:string}[]} files  from resolveFiles
 * @param {object} opts  { rng, vp, raw, mouse }  `mouse: false` (a touch-only profile, no fine pointer):
 *                       an OS file drag is not pointer input and is allowed, but no mouse move is synced afterwards
 */
async function dropFiles(page, files, rawTarget, opts = {}) {
  const rng = opts.rng || Math.random;
  const vp = opts.vp || await human.viewportMetrics(page);
  human.noteDpr(page, vp.dpr);
  const cdp = await human.getCdpSession(page);
  if (!cdp) throw new Error('drop-files needs a CDP session to the page, which could not be created');
  const st = human.inputState(page);
  const dpr = human.dprOf(page);
  const snap = (p) => ({ x: human.q(p.x, dpr), y: human.q(p.y, dpr) });         // every point on the device-pixel grid
  const target = snap(rawTarget);
  const data = { items: [], files: files.map((f) => f.path), dragOperationsMask: DRAG_OPERATIONS_MASK };
  const ev = (type, x, y) => cdp.send('Input.dispatchDragEvent', { type, x, y, data, modifiers: st.modifiers });
  const t0 = Date.now();
  let entered = false, dropped = false;
  let entry = { x: target.x, y: target.y };
  try {
    if (opts.raw) {
      await ev('dragEnter', target.x, target.y); entered = true;
      await ev('dragOver', target.x, target.y);
      await ev('drop', target.x, target.y); dropped = true;
    } else {
      entry = snap(entryPoint(target, vp, rng));
      await ev('dragEnter', entry.x, entry.y); entered = true;
      await human.sleep(human.logNormal(rng, 60, 0.3, 25, 140));
      const d = Math.hypot(target.x - entry.x, target.y - entry.y);
      const durationMs = human.moveDurationMs(d, 60, rng) * 1.2;       // dragging a file in is a deliberate move
      const { path: pts, steps } = human.samplePath(entry, target, rng);
      const frame = durationMs / steps;
      for (const raw of pts) {
        const p = snap(raw);
        const t = timing.now();
        await ev('dragOver', p.x, p.y);
        // an absolute schedule: the dispatch round trip counts against the frame
        await timing.preciseSleepUntil(t + (raw.pauseMs || 0) + frame * (1 + (rng() - 0.5) * 0.5));
      }
      await human.sleep(human.logNormal(rng, 170, 0.3, 80, 420));      // hover over the drop zone, then let go
      await ev('dragOver', target.x, target.y);
      await ev('drop', target.x, target.y); dropped = true;
    }
  } finally {
    if (entered && !dropped) { try { await ev('dragCancel', target.x, target.y); } catch { /* ignore */ } }
  }
  // the cursor ends where the files were dropped: tell Playwright's mouse and our tracked pointer
  // (skipped when the profile has no mouse: a mouse move there would contradict the fingerprint)
  if (opts.mouse !== false) {
    try { await page.mouse.move(target.x, target.y, { steps: 1 }); } catch { /* ignore */ }
    human.setPos(page, target);
    st.synced = true;
  }
  const r3 = (n) => Math.round(n * 1000) / 1000;
  return {
    entry: { x: r3(entry.x), y: r3(entry.y) },
    landedAt: { x: r3(target.x), y: r3(target.y) },
    durationMs: Date.now() - t0,
  };
}

module.exports = { resolveFiles, dropFiles, entryPoint };
