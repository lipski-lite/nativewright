'use strict';

/**
 * Coordinate spaces and validation for the coordinate commands
 * (click-at, hover-at, element-at, drag-at, tap-at, ...).
 *
 *   css         CSS px relative to the viewport — what clientX/clientY report.
 *   screenshot  device pixels measured on a `shot` image taken with the default
 *               --scale=device of the viewport. css = px / devicePixelRatio.
 *               For element offsets (`--at`) the offset is measured on an
 *               element screenshot (`shot --selector=`): css offset = px / dpr.
 *
 * Why this exists: on a display scaled to 150% (dpr 1.5) a point read off a
 * screenshot is 1.5x its CSS position, so clicking at the raw screenshot
 * number lands 50% too far right/down. Every error here states the viewport
 * size, the dpr and the converted css values so such a mistake is obvious.
 *
 * @module coords
 */

const NUM_RE = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;

function round3(n) { return Math.round(n * 1000) / 1000; }

/** Strict numeric parse: only real numbers (never "20 junk", "", true, NaN). */
function parseNumber(v, label) {
  if (v === undefined || v === null || v === '' || v === true) throw new Error(`${label} is required (a number)`);
  const n = typeof v === 'number' ? v : (typeof v === 'string' && NUM_RE.test(v) ? Number(v) : NaN);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number, got ${JSON.stringify(v)}`);
  return n;
}

function parseSpace(v) {
  if (v == null || v === true || v === '') return 'css';
  const s = String(v).toLowerCase();
  if (s !== 'css' && s !== 'screenshot') throw new Error(`bad --space '${v}' (use css or screenshot)`);
  return s;
}

function toCss(n, space, dpr) { return space === 'screenshot' ? n / dpr : n; }

function vpText(vp) { return `viewport ${vp.width}x${vp.height} CSS px, dpr ${vp.dpr}`; }

/**
 * Convert and validate one viewport point.
 * @returns {{requested:{x:number,y:number,space:string}, css:{x:number,y:number}, exact:{x:number,y:number}}}
 */
function resolvePoint(xRaw, yRaw, space, vp, labels = ['x', 'y']) {
  const x = parseNumber(xRaw, labels[0]);
  const y = parseNumber(yRaw, labels[1]);
  const dpr = vp.dpr || 1;
  const cx = toCss(x, space, dpr), cy = toCss(y, space, dpr);
  if (!(cx >= 0 && cx < vp.width && cy >= 0 && cy < vp.height)) {
    throw new Error(
      `point (${labels[0]}=${x}, ${labels[1]}=${y}) [space=${space}] is outside the viewport: ${vpText(vp)}; ` +
      `converted to css (${round3(cx)}, ${round3(cy)}); valid css range is x 0..${vp.width - 1}, y 0..${vp.height - 1}` +
      (space === 'css' && (x > vp.width || y > vp.height) && (x / dpr < vp.width && y / dpr < vp.height)
        ? ` (hint: these numbers fit the viewport at dpr ${dpr} - did you mean --space=screenshot?)` : ''));
  }
  return { requested: { x, y, space }, css: { x: round3(cx), y: round3(cy) }, exact: { x: cx, y: cy } };
}

/** Parse "--at=x,y" (also accepts "x y"). */
function parseAt(v, label = '--at') {
  if (v == null || v === true || v === '') throw new Error(`${label} requires a value like ${label}=12,34`);
  const parts = String(v).trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) throw new Error(`${label} must be two numbers "x,y", got ${JSON.stringify(v)}`);
  return { x: parseNumber(parts[0], `${label} x`), y: parseNumber(parts[1], `${label} y`) };
}

/**
 * Convert and validate an offset inside an element's box (`--at`).
 * @param {{x:number,y:number,width:number,height:number}} box  element box in viewport CSS px
 */
function resolveOffset(at, space, vp, box, label = '--at') {
  const dpr = vp.dpr || 1;
  const ox = toCss(at.x, space, dpr), oy = toCss(at.y, space, dpr);
  if (!(ox >= 0 && ox < box.width && oy >= 0 && oy < box.height)) {
    throw new Error(
      `${label} offset (${at.x}, ${at.y}) [space=${space}] is outside the element box: box ${round3(box.width)}x${round3(box.height)} CSS px ` +
      `at (${round3(box.x)}, ${round3(box.y)}); ${vpText(vp)}; converted to css offset (${round3(ox)}, ${round3(oy)}); ` +
      `valid css offsets are x 0..${round3(box.width)}, y 0..${round3(box.height)}` +
      (space === 'css' ? ' (offsets measured on an element screenshot need --space=screenshot)' : ''));
  }
  return { x: ox, y: oy };
}

module.exports = { parseNumber, parseSpace, resolvePoint, parseAt, resolveOffset, toCss, round3, vpText };
