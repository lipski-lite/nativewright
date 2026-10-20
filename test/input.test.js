'use strict';

/**
 * v2.2 "low-level input layer" integration tests — real daemon, real Chrome.
 *
 * Isolation (the machine may run a REAL daemon on a logged-in profile, and
 * NATIVEWRIGHT_HOME / NATIVEWRIGHT_USER_DATA_DIR may be set machine-wide):
 * every daemon started here gets fresh temp dirs for HOME, USER_DATA_DIR and
 * ARTIFACTS_DIR, and the variables that could redirect it (PAGE, PROFILE,
 * TOUCH, ...) are deleted from its environment. NATIVEWRIGHT_HOME is also
 * overridden in THIS process before any src module loads, so in-process unit
 * tests can never touch the real data directory. (The clipboard lock is
 * machine-wide and lives in os.tmpdir(), outside any data root: the unit tests
 * of its protocol use an explicit `file`, and only the pastes that really go
 * through the OS clipboard take the real one.)
 *
 * The fixture HTTP server runs in a CHILD process: the CLI helper uses
 * spawnSync, which blocks this process's event loop — an in-process server
 * would deadlock. It serves test/fixtures/*.html on two origins that are
 * different SITES (127.0.0.1 vs localhost), so the cross-origin iframe is a
 * genuine out-of-process frame, and on a third (127.0.0.2, "a website" for
 * calibrate-wheel's guard) wherever that address is bound (not on macOS).
 *
 * Fixture pages record their events into DOM nodes; the product's evaluate
 * runs in an isolated world and reads the shared DOM. Scripts in a fixture run
 * in the page's MAIN world, like a site's own.
 *
 * Timing assertions have to hold on a loaded CI VM (process.env.CI) as well as
 * on a workstation: the structural ones (no event in the future, nothing on the
 * 15.625 ms timer lattice) never relax, the absolute-latency ones do.
 *
 * Run headless:  NATIVEWRIGHT_HEADLESS=1 npm test      headed (dpr 1.5 here): npm test
 */

const test = require('node:test');
const { describe, it, before, after } = test;
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'src', 'browser.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const HEADLESS = /^(1|true|yes|on)$/i.test(process.env.NATIVEWRIGHT_HEADLESS || process.env.PATCHRIGHT_HEADLESS || '');
const CI = !!process.env.CI;                       // GitHub Actions: shared VMs under load
// `skip` option of the Windows-only tests: the clipboard helper is a PowerShell process (false = run, a string = skip with that reason)
const WINDOWS_ONLY = process.platform === 'win32' ? false : 'Windows only: the clipboard helper is a PowerShell process';

// ---------------------------------------------------------------------------
// isolation
// ---------------------------------------------------------------------------

function mkTmp(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `nativewright-input-${label}-`)); }
function mkDirs(label) {
  return { label, home: mkTmp(label + '-home'), profile: mkTmp(label + '-profile'), artifacts: mkTmp(label + '-artifacts'), work: mkTmp(label + '-work') };
}
const MAIN = mkDirs('main');
const TOUCH = mkDirs('touch');
const SECOND = mkDirs('second');                 // only started by the (headed) two-daemon clipboard test
process.env.NATIVEWRIGHT_HOME = MAIN.home;      // before any src module is required in this process

const DANGEROUS = [
  'NATIVEWRIGHT_PAGE', 'PATCHRIGHT_PAGE', 'NATIVEWRIGHT_PROFILE', 'PATCHRIGHT_PROFILE',
  'PATCHRIGHT_USER_DATA_DIR', 'PATCHRIGHT_HOME', 'PATCHRIGHT_ARTIFACTS_DIR',
  'NATIVEWRIGHT_TOUCH', 'PATCHRIGHT_TOUCH', 'NATIVEWRIGHT_LAYOUT_SWITCH', 'PATCHRIGHT_LAYOUT_SWITCH',
];
function envFor(d, extra = {}) {
  const env = { ...process.env };
  for (const k of DANGEROUS) delete env[k];
  env.NATIVEWRIGHT_HOME = d.home;
  env.NATIVEWRIGHT_USER_DATA_DIR = d.profile;
  env.NATIVEWRIGHT_ARTIFACTS_DIR = d.artifacts;
  return Object.assign(env, extra);
}
MAIN.env = envFor(MAIN);
TOUCH.env = envFor(TOUCH, { NATIVEWRIGHT_TOUCH: '1' });
SECOND.env = envFor(SECOND);

// ---------------------------------------------------------------------------
// fixture server (child process)
// ---------------------------------------------------------------------------

const FIXTURE_SRC = `
  const http = require('http'), fs = require('fs'), path = require('path');
  const dir = process.env.FIXTURE_DIR;
  let originA = '', originB = '';
  function handler(q, r) {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const name = path.basename(u === '/' ? '/index.html' : u);
    const file = path.join(dir, name);
    if (!/^[\\w.-]+\\.html$/.test(name) || !fs.existsSync(file)) { r.writeHead(404); return r.end('not found'); }
    const body = fs.readFileSync(file, 'utf8').replace(/\\{\\{ORIGIN_A\\}\\}/g, originA).replace(/\\{\\{ORIGIN_B\\}\\}/g, originB);
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    r.end(body);
  }
  const a = http.createServer(handler), b = http.createServer(handler), c = http.createServer(handler);
  a.listen(0, '127.0.0.1', () => b.listen(0, '127.0.0.1', () => {
    originA = 'http://127.0.0.1:' + a.address().port;
    originB = 'http://localhost:' + b.address().port;
    // A third origin on 127.0.0.2: loopback, but NOT one of the local names calibrate-wheel accepts (localhost, 127.0.0.1, [::1]), so it
    // stands in for "a website". Linux and Windows route all of 127.0.0.0/8 to loopback; macOS has only 127.0.0.1 on lo0, the bind
    // fails there and the tests that need it skip ('-').
    const done = (originC) => process.stdout.write('ORIGINS ' + originA + ' ' + originB + ' ' + (originC || '-') + '\\n');
    c.once('error', () => done(null));
    c.listen(0, '127.0.0.2', () => done('http://127.0.0.2:' + c.address().port));
  }));
`;
let fixture = null;
let ORIGIN_A = null, ORIGIN_B = null, ORIGIN_C = null;

async function startFixture() {
  fixture = spawn(process.execPath, ['-e', FIXTURE_SRC], {
    env: { ...process.env, FIXTURE_DIR: FIXTURES }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    fixture.stdout.on('data', (c) => {
      buf += c;
      const m = /ORIGINS (\S+) (\S+) (\S+)/.exec(buf);
      if (m) { ORIGIN_A = m[1]; ORIGIN_B = m[2]; ORIGIN_C = m[3] === '-' ? null : m[3]; resolve(); }
    });
    fixture.once('exit', (code) => reject(new Error('fixture server exited early: ' + code)));
  });
}

// ---------------------------------------------------------------------------
// CLI + daemon helpers
// ---------------------------------------------------------------------------

function cli(d, args, { timeout = 150_000 } = {}) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], { env: d.env, timeout, encoding: 'utf8', cwd: d.work });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  let body = null;
  if (out) { try { body = JSON.parse(out); } catch { /* not JSON */ } }
  return { exitCode: res.status, body, raw: out, stderr: res.stderr };
}

/** Same as cli() but does not block this process's event loop (two daemons driven at once). */
function cliAsync(d, args, { timeout = 240_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [ENTRY, ...args], { env: d.env, cwd: d.work, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    const timer = setTimeout(() => { try { c.kill(); } catch { /* ignore */ } reject(new Error(`cliAsync timeout: ${args.join(' ')}`)); }, timeout);
    c.stdout.on('data', (x) => { so += x; });
    c.stderr.on('data', (x) => { se += x; });
    c.once('error', (e) => { clearTimeout(timer); reject(e); });
    c.once('exit', (code) => {
      clearTimeout(timer);
      const raw = so.trim();
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { /* not JSON */ } }
      resolve({ exitCode: code, body, raw, stderr: se });
    });
  });
}

/** Read-only look at the OS clipboard through the product's own backend: { kind: 'empty'|'text'|'other'|'none'|'error', formats, text }. */
async function clipState() {
  const { detectBackend } = require('../src/clipboard');
  const d = await detectBackend();
  if (!d.backend) return { kind: 'none', reason: d.reason };
  try { return await d.backend.snapshot(); } catch (e) { return { kind: 'error', error: e.message }; }
}

const daemons = [];
async function startDaemon(d) {
  const child = spawn(process.execPath, [ENTRY, 'start'], { env: d.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', se = '';
  child.stdout.on('data', (c) => { so += c; });
  child.stderr.on('data', (c) => { se += c; });
  d.child = child;
  daemons.push(d);
  const ready = cli(d, ['wait-ready', '--timeout=60000']);
  assert.equal(ready.exitCode, 0, `wait-ready failed: ${ready.raw} ${ready.stderr}\ndaemon stdout: ${so}\ndaemon stderr: ${se}`);
}

/** A daemon + the page this suite drives on it. */
class Session {
  constructor(d) { this.d = d; this.page = null; }
  newPage(label) {
    const r = cli(this.d, ['new', `--label=${label}`]);
    assert.equal(r.body && r.body.ok, true, `new failed: ${r.raw}`);
    this.page = r.body.result.page;
    return this.page;
  }
  call(args, o) { return cli(this.d, [...args, `--page=${this.page}`], o); }
  ok(args, o) {
    const r = this.call(args, o);
    assert.equal(r.body && r.body.ok, true, `${args.join(' ')} failed: ${r.raw.slice(0, 600)} ${r.stderr}`);
    return r.body.result;
  }
  bad(args, o) {
    const r = this.call(args, o);
    assert.equal(r.exitCode, 1, `${args.join(' ')} should have failed`);
    assert.equal(r.body.ok, false);
    return r.body;
  }
  eval(js) { return this.ok(['eval', js]).value; }
  evalJson(js) { return JSON.parse(this.eval(`JSON.stringify(${js})`)); }
  log() { return this.evalJson('[...document.querySelectorAll("#log i")].map(i=>JSON.parse(i.textContent))'); }
  clearLog() { this.eval('document.getElementById("log").replaceChildren(), 1'); }
  go(name) { this.ok(['goto', `${ORIGIN_A}/${name}.html`, '--raw=true']); this.clearLog(); }
  rect(sel) { return this.evalJson(`(r => ({x: r.x, y: r.y, width: r.width, height: r.height}))(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`); }
  center(sel) { const r = this.rect(sel); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
  metrics() { return this.evalJson('({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})'); }
  pageInfo() { return this.ok(['pages']).find((p) => p.page === this.page); }
  held() { return this.pageInfo().input.held; }
  pointer() { return this.pageInfo().input.pointer; }
  reset(name) { this.ok(['release']); if (name) this.go(name); }
  expectNothingHeld(why) { assert.deepEqual(this.held(), { buttons: [], keys: [] }, `something is still held ${why || ''}`); }
}

const S = new Session(MAIN);
const T = new Session(TOUCH);

const mouseLog = (log) => log.filter((e) => e[0] === 'm');
const keyLog = (log) => log.filter((e) => e[0] === 'k');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} is not within ${tol} of ${b}`);

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  await startFixture();
  await startDaemon(MAIN);
  S.newPage('input-tests');
});

after(async () => {
  for (const d of daemons) {
    try { cli(d, ['stop', '--force'], { timeout: 20_000 }); } catch { /* ignore */ }
    if (d.child && d.child.exitCode == null) { try { d.child.kill('SIGTERM'); } catch { /* ignore */ } }
  }
  try { require('../src/clipboard').dispose(); } catch { /* ignore */ }
  try { if (fixture) fixture.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 600));
  for (const d of [MAIN, TOUCH, SECOND]) {
    for (const k of ['home', 'profile', 'artifacts', 'work']) { try { fs.rmSync(d[k], { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

// ===========================================================================
// B1: the real viewport + visibility of the input state
// ===========================================================================

describe('B1 real viewport + input state visibility', () => {
  it('coordinate commands use the real viewport (innerWidth x innerHeight x dpr), not a 1280x800 fallback', () => {
    S.reset('canvas');
    const m = S.metrics();
    const r = S.ok(['element-at', '5', '5']);
    assert.deepEqual(r.viewport, { width: m.w, height: m.h });
    assert.equal(r.dpr, m.dpr);
    assert.ok(r.viewport.width !== 1280 || r.viewport.height !== 800, 'viewport must be measured, not the old fallback');
  });

  it('save-artifact records the real viewport metrics object (not null)', () => {
    S.reset('canvas');
    const r = S.ok(['save-artifact', 'vp']);
    const meta = JSON.parse(fs.readFileSync(r.meta, 'utf8'));
    const m = S.metrics();
    assert.equal(meta.viewport.width, m.w);
    assert.equal(meta.viewport.height, m.h);
    assert.equal(meta.viewport.dpr, m.dpr);
    assert.ok('scrollX' in meta.viewport && 'scrollY' in meta.viewport);
  });

  it('pages and state expose input: pointer + held buttons/keys', () => {
    S.reset('canvas');
    const info = S.pageInfo();
    assert.ok(info.input && 'pointer' in info.input && info.input.held, 'pages entry has input');
    assert.deepEqual(info.input.held, { buttons: [], keys: [] });
    const st = S.ok(['state']);
    assert.ok(st.pages.every((p) => p.input && p.input.held), 'state pages carry input too');
  });

  it('the first pointer position lands inside the real viewport (20-80%)', () => {
    const fresh = new Session(MAIN);
    fresh.newPage('fresh-pointer');
    try {
      fresh.go('canvas');
      assert.equal(fresh.pointer(), null, 'a fresh page has no pointer position yet');
      const m = fresh.metrics();
      const d = fresh.ok(['mouse-down']);
      assert.ok(d.at.x >= m.w * 0.2 - 1 && d.at.x <= m.w * 0.8 + 1 && d.at.y >= m.h * 0.2 - 1 && d.at.y <= m.h * 0.8 + 1,
        `initial pointer (${d.at.x},${d.at.y}) must be inside the ${m.w}x${m.h} viewport`);
      fresh.ok(['mouse-up']);
    } finally { fresh.ok(['close']); }
  });

  it('an element far below is reached with real wheel scrolling (not a programmatic jump) now that the viewport is right', () => {
    S.reset('tall');
    const r = S.ok(['click', '#far']);
    const log = S.log();
    const wheels = log.filter((e) => e[0] === 'w');
    assert.ok(wheels.length > 3, `expected human wheel scrolling toward the element (${wheels.length} wheel events)`);
    assert.ok(wheels.every((w) => w[3] === 0 && w[4] === true), 'wheel events are trusted pixel-mode events');
    const click = log.find((e) => e[0] === 'far-click');
    assert.ok(click && click[3] === true, 'the click landed on #far');
    assert.ok(r.targetBox.y >= 0);
  });
});

// ===========================================================================
// click-at / hover-at / element-at / selector flags
// ===========================================================================

describe('click-at, hover-at, element-at', () => {
  it('click-at on the canvas: lands within 2px, trusted, button + detail correct, full response shape', () => {
    S.reset('canvas');
    const dpr = S.metrics().dpr;
    const cv = S.rect('#cv');
    const x = Math.round(cv.x + 150), y = Math.round(cv.y + 100);
    const r = S.ok(['click-at', String(x), String(y)]);
    assert.deepEqual(r.requested, { x, y, space: 'css' });
    assert.deepEqual(r.css, { x, y });
    assert.equal(r.dpr, dpr);
    assert.equal(r.hit.id, 'cv');
    assert.equal(r.button, 'left');
    assert.equal(r.clickCount, 1);
    assert.ok(Number.isFinite(r.moveMs) && Number.isFinite(r.totalMs) && r.landedAt && r.hit.box);
    assert.ok(Math.hypot(r.landedAt.x - x, r.landedAt.y - y) <= 2.01, 'landing jitter is clamped to 2px');
    const log = S.log();
    const ms = mouseLog(log);
    assert.deepEqual(ms.map((e) => e[1]), ['mousedown', 'mouseup', 'click']);
    for (const e of ms) {
      // Chrome truncates MouseEvent.clientX/Y to integers (PointerEvent keeps the fraction): jitter <= 2 plus truncation
      // is still within 2px PER AXIS of an integer request
      assert.ok(Math.abs(e[2] - x) <= 2 && Math.abs(e[3] - y) <= 2, `${e[1]} at (${e[2]},${e[3]}) is within 2px of (${x},${y})`);
      assert.equal(e[4], 0, 'button 0 = left');
      assert.equal(e[6], 1, 'detail 1');
      assert.equal(e[7], true, 'isTrusted');
      assert.equal(e[11], 'cv');
    }
    assert.equal(ms[0][5], 1, 'buttons=1 on mousedown');
    const pd = log.find((e) => e[0] === 'pd');       // PointerEvent: the exact (fractional) landing point
    assert.equal(pd[1], 'mouse');
    assert.equal(pd[5], true, 'trusted pointerdown');
    assert.ok(Math.hypot(pd[3] - x, pd[4] - y) <= 2.01, `pointerdown at (${pd[3]},${pd[4]}) is within 2px of (${x},${y})`);
    near(pd[3], r.landedAt.x, 0.01, 'pointerdown x equals the reported landing point');
    near(pd[4], r.landedAt.y, 0.01, 'pointerdown y equals the reported landing point');
  });

  it('click-at --exact lands on the requested point exactly; a flagless click emits no keyboard events', () => {
    S.reset('canvas');
    const b = S.center('#btn');
    S.ok(['click-at', String(Math.round(b.x)), String(Math.round(b.y)), '--exact=true']);
    const log = S.log();
    assert.equal(keyLog(log).length, 0, 'no key events around a plain click');
    for (const e of mouseLog(log)) near(e[2], Math.round(b.x), 0.01, 'x'), near(e[3], Math.round(b.y), 0.01, 'y');
    assert.equal(mouseLog(log)[0][11], 'btn');
  });

  it('click-at --button=right fires contextmenu with button 2; --clickCount=2 gives detail 2 and a dblclick', () => {
    S.reset('canvas');
    const cv = S.rect('#cv');
    const x = Math.round(cv.x + 80), y = Math.round(cv.y + 80);
    S.ok(['click-at', String(x), String(y), '--button=right']);
    let ms = mouseLog(S.log());
    // Chrome fires `contextmenu` on mouseup on Windows but on mousedown on macOS and Linux (measured: this test failed on both in CI)
    assert.deepEqual(ms.map((e) => e[1]), process.platform === 'win32' ? ['mousedown', 'mouseup', 'contextmenu'] : ['mousedown', 'contextmenu', 'mouseup']);
    assert.ok(ms.every((e) => e[4] === 2), 'right button = 2');
    S.clearLog();
    S.ok(['click-at', String(x), String(y), '--clickCount=2']);
    ms = mouseLog(S.log());
    assert.deepEqual(ms.map((e) => e[1]), ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick']);
    assert.deepEqual(ms.filter((e) => e[1] === 'click').map((e) => e[6]), [1, 2]);
    assert.equal(ms[6][6], 2, 'dblclick has detail 2');
  });

  it('click-at --modifiers=Shift: ShiftLeft keydown BEFORE mousedown (shiftKey true), keyup AFTER mouseup', () => {
    S.reset('canvas');
    const b = S.center('#btn');
    const r = S.ok(['click-at', String(Math.round(b.x)), String(Math.round(b.y)), '--modifiers=Shift']);
    const seq = S.log().map((e) => (e[0] === 'k' ? `k:${e[1]}:${e[3]}` : `m:${e[1]}${e[8] ? ':shift' : ''}`));
    assert.deepEqual(seq, ['k:keydown:ShiftLeft', 'm:mousedown:shift', 'm:mouseup:shift', 'm:click:shift', 'k:keyup:ShiftLeft']);
    const down = keyLog(S.log())[0];
    assert.equal(down[6], true, 'keydown ShiftLeft has shiftKey');
    assert.equal(down[10], 1, 'location 1 = left');
    assert.ok(r.hit);
    S.expectNothingHeld('after a modifier click');
  });

  it('click-at --hold=600 keeps the button down >= 550 ms', () => {
    S.reset('canvas');
    const b = S.center('#btn');
    S.ok(['click-at', String(Math.round(b.x)), String(Math.round(b.y)), '--hold=600']);
    const ms = mouseLog(S.log());
    const dt = ms.find((e) => e[1] === 'mouseup')[12] - ms.find((e) => e[1] === 'mousedown')[12];
    assert.ok(dt >= 550 && dt < 1500, `held for ${dt} ms`);
  });

  it('modifier aliases and several modifiers (Ctrl, Cmd) are accepted case-insensitively', () => {
    S.reset('canvas');
    const b = S.center('#btn');
    S.ok(['click-at', String(Math.round(b.x)), String(Math.round(b.y)), '--modifiers=ctrl,SHIFT']);
    const log = S.log();
    const downs = keyLog(log).filter((e) => e[1] === 'keydown').map((e) => e[3]);
    assert.deepEqual(downs, ['ControlLeft', 'ShiftLeft']);
    const md = mouseLog(log).find((e) => e[1] === 'mousedown');
    assert.equal(md[9], true, 'ctrlKey');
    assert.equal(md[8], true, 'shiftKey');
    S.expectNothingHeld();
    const e = S.bad(['click-at', '10', '10', '--modifiers=Hyper']);
    assert.match(e.error, /unknown modifier/);
  });

  it('a long move to click-at keeps coalesced pointer events (> 1 sub-sample) on fast segments', () => {
    S.reset('canvas');
    const m = S.metrics();
    S.ok(['hover-at', String(Math.round(m.w * 0.9)), String(Math.round(m.h * 0.8)), '--exact=true']);
    const cv = S.rect('#cv');
    S.ok(['click-at', String(Math.round(cv.x + 40)), String(Math.round(cv.y + 40))]);
    const stats = JSON.parse(S.eval('document.getElementById("stats").textContent'));
    assert.ok(stats.n > 3, `pointermoves over the canvas: ${stats.n}`);
    assert.ok(stats.maxCoalesced > 1 && stats.multi >= 1, `coalesced sub-events present (max ${stats.maxCoalesced}, ${stats.multi} multi)`);
    assert.deepEqual(stats.pointerTypes, ['mouse']);
  });

  it('hover-at moves the pointer without pressing anything and reports the hit', () => {
    S.reset('canvas');
    const b = S.center('#btn');
    const r = S.ok(['hover-at', String(Math.round(b.x)), String(Math.round(b.y))]);
    assert.equal(r.hit.id, 'btn');
    assert.deepEqual(mouseLog(S.log()).filter((e) => e[1] !== 'mousemove'), []);
    near(S.pointer().x, Math.round(b.x), 2.5);
    near(S.pointer().y, Math.round(b.y), 2.5);
  });

  it('element-at describes a link, an input, a titled node and an id-less element (no input dispatched)', () => {
    S.reset('canvas');
    const at = (sel) => { const c = S.center(sel); return S.ok(['element-at', String(Math.round(c.x)), String(Math.round(c.y))]); };
    const link = at('#link').hit;
    assert.equal(link.tag, 'a');
    assert.deepEqual(link.classes, ['nav', 'primary']);
    assert.equal(link.role, 'link');
    assert.equal(link.href, `${ORIGIN_A}/canvas.html#x`);
    assert.equal(link.text, 'a link');
    assert.equal(link.cursor, 'pointer');
    assert.equal(link.draggable, true, 'a[href] is draggable by default (effective draggable)');
    const txt = at('#txt').hit;
    assert.equal(txt.tag, 'input');
    assert.equal(txt.editable, true);
    assert.equal(txt.name, 'text box', 'aria-label');
    assert.equal(txt.role, 'textbox');
    const mark = at('#mark').hit;
    assert.equal(mark.role, 'note');
    assert.equal(mark.name, 'the mark', 'title');
    assert.equal(mark.draggable, false);
    const r = at('#btn');
    assert.deepEqual(r.hit.box, (({ x, y, width, height }) => ({ x, y, width, height }))(S.rect('#btn')), 'box is viewport CSS px');
    assert.equal(r.hit.selectorHint, '#btn');
    // selector hints are short AND unique, including an element with no id
    for (const sel of ['li.it', 'ul > li:nth-of-type(3)']) {
      const c = S.center(sel);
      const hint = S.ok(['element-at', String(Math.round(c.x)), String(Math.round(c.y))]).hit.selectorHint;
      assert.equal(S.ok(['count', hint]).count, 1, `selectorHint ${hint} must match exactly one element`);
    }
    assert.equal(mouseLog(S.log()).length, 0, 'element-at dispatches no input');
  });

  it('element-at drills into a same-origin iframe AND a cross-site iframe (frames chain, page-level boxes)', () => {
    S.reset('frames');
    for (const [id, expectUrl] of [['same', `${ORIGIN_A}/inner.html`], ['cross', `${ORIGIN_B}/inner.html`]]) {
      const f = S.evalJson(`(el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); const px = v => parseFloat(v) || 0;
        return { x: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft), y: r.top + px(cs.borderTopWidth) + px(cs.paddingTop), bx: r.left, by: r.top }; })(document.getElementById(${JSON.stringify(id)}))`);
      const cx = Math.round(f.x + 30 + 60), cy = Math.round(f.y + 30 + 20);     // the button sits at (30,30) in the frame, 120x40
      const r = S.ok(['element-at', String(cx), String(cy)]);
      assert.equal(r.hit.id, 'ib', `${id}: innermost element`);
      assert.equal(r.frames.length, 1, `${id}: iframe chain`);
      assert.equal(r.frames[0].url, expectUrl);
      near(r.frames[0].box.x, f.bx, 1, `${id} frame box x`);
      near(r.hit.box.x, f.x + 30, 1, `${id}: hit box is translated to page-level viewport px`);
      near(r.hit.box.y, f.y + 30, 1);
      near(r.hit.box.width, 120, 0.1);
      // ground truth: a click at the reported box centre really reaches the button inside that frame
      S.clearLog();
      S.ok(['click-at', String(Math.round(r.hit.box.x + 60)), String(Math.round(r.hit.box.y + 20))]);
      const msg = S.log().find((e) => e[0] === 'msg');
      assert.ok(msg && msg[4] === true, `${id}: the click reached the frame's button`);
      assert.equal(msg[1], id === 'same' ? ORIGIN_A : ORIGIN_B);
    }
  });

  it('click-at into the cross-origin iframe\'s button works (raw input at page coordinates is routed by Chrome)', () => {
    S.reset('frames');
    const f = S.rect('#cross');
    const x = Math.round(f.x + 2 + 30 + 60), y = Math.round(f.y + 2 + 30 + 20);
    const r = S.ok(['click-at', String(x), String(y)]);
    assert.equal(r.hit.id, 'ib');
    assert.equal(r.frames.length, 1);
    const msg = S.log().find((e) => e[0] === 'msg');
    assert.ok(msg, 'the cross-origin button reported a click via postMessage');
    assert.equal(msg[1], ORIGIN_B);
    assert.equal(msg[4], true, 'trusted click');
    near(msg[2], x - (f.x + 2), 3, 'click x inside the frame');
    near(msg[3], y - (f.y + 2), 3, 'click y inside the frame');
  });

  it('click <selector> --at=x,y lands at box + offset; --space=screenshot offsets are divided by dpr; out-of-box is an error', () => {
    S.reset('canvas');
    const dpr = S.metrics().dpr;
    const box = S.rect('#cv');
    const r = S.ok(['click', '#cv', '--at=100,50']);
    near(r.landedAt.x, box.x + 100, 2.1, 'landedAt.x');
    near(r.landedAt.y, box.y + 50, 2.1, 'landedAt.y');
    const ms = mouseLog(S.log());
    near(ms[0][2], box.x + 100, 2.2);
    near(ms[0][3], box.y + 50, 2.2);
    S.clearLog();
    S.ok(['click', '#cv', `--at=${100 * dpr},${50 * dpr}`, '--space=screenshot', '--exact=true']);
    const m2 = mouseLog(S.log())[0];
    near(m2[2], box.x + 100, 0.6, 'screenshot-space offset / dpr');
    near(m2[3], box.y + 50, 0.6);
    const e = S.bad(['click', '#cv', '--at=9999,5', '--timeout=3000']);
    assert.match(e.error, /outside the element box/);
    assert.match(e.error, /dpr/);
    S.expectNothingHeld('after a rejected --at');
  });

  it('hover <selector> --at, dblclick/rightclick still work, and the selector click family takes --hold/--modifiers', () => {
    S.reset('canvas');
    const box = S.rect('#cv');
    const h = S.ok(['hover', '#cv', '--at=30,30', '--exact=true']);
    near(h.landedAt.x, box.x + 30, 1);
    S.clearLog();
    S.ok(['dblclick', '#btn']);
    assert.ok(mouseLog(S.log()).some((e) => e[1] === 'dblclick' && e[6] === 2), 'dblclick fires a real dblclick (detail 2)');
    S.clearLog();
    S.ok(['rightclick', '#btn']);
    assert.ok(mouseLog(S.log()).some((e) => e[1] === 'contextmenu'));
    S.clearLog();
    S.ok(['click', '#btn', '--hold=500', '--modifiers=Control']);
    const log = S.log();
    const dt = mouseLog(log).find((e) => e[1] === 'mouseup')[12] - mouseLog(log).find((e) => e[1] === 'mousedown')[12];
    assert.ok(dt >= 450, `selector click --hold: ${dt} ms`);
    assert.equal(mouseLog(log).find((e) => e[1] === 'mousedown')[9], true, 'ctrlKey');
    S.expectNothingHeld();
  });

  it('--space=screenshot round trip: shot -> dpr -> click-at (cssCenter x dpr) hits the element', () => {
    S.reset('canvas');
    const s = S.ok(['shot', 'roundtrip']);
    const c = S.center('#btn');
    const r = S.ok(['click-at', String(c.x * s.dpr), String(c.y * s.dpr), '--space=screenshot', '--exact=true']);
    assert.equal(r.requested.space, 'screenshot');
    assert.equal(r.hit.id, 'btn');
    near(r.css.x, c.x, 0.01);
    assert.equal(mouseLog(S.log())[0][11], 'btn');
    if (s.dpr !== 1) {
      // the DPR trap: the same numbers read as CSS px are outside the viewport (or elsewhere)
      const wrong = S.call(['element-at', String(c.x * s.dpr), String(c.y * s.dpr)]);
      assert.ok(wrong.body.ok === false || wrong.body.result.hit.id !== 'btn', 'raw screenshot pixels are NOT css px');
    }
  });

  it('error paths return ok:false with a useful message and leave nothing held', () => {
    S.reset('canvas');
    const m = S.metrics();
    const e1 = S.bad(['click-at', String(m.w + 500), '20']);
    assert.match(e1.error, /outside the viewport/);
    assert.match(e1.error, new RegExp(`${m.w}x${m.h}`));
    assert.match(e1.error, /dpr/);
    assert.match(e1.error, /converted to css/);
    const e2 = S.bad(['click-at', '-3', '20']);
    assert.match(e2.error, /outside the viewport/);
    const e3 = S.bad(['drag', '#nope-from', '#nope-to', '--timeout=1500']);
    assert.equal(e3.ok, false);
    const e4 = S.bad(['drag', '#btn']);
    assert.match(e4.error, /two selectors/);
    const e5 = S.bad(['click-at', '10', '10', '--button=banana']);
    assert.match(e5.error, /bad --button/);
    const e6 = S.bad(['click-at', '10', '10', '--clickCount=4']);
    assert.match(e6.error, /clickCount/);
    S.expectNothingHeld('after every error');
  });

  it('the CLI validates numeric positionals strictly (click-at 10 20 junk is an error, not a misparse)', () => {
    const run = (args) => cli(MAIN, [...args, `--page=${S.page}`]);
    for (const args of [['click-at', '10', '20', 'junk'], ['click-at', '10'], ['click-at', 'ten', '20'], ['hover-at', '1', '2', '3'],
      ['element-at', '5', '5x'], ['drag-at', '1', '2', '3'], ['drag-at', '1', '2', '3', '4', '5']]) {
      const r = run(args);
      assert.equal(r.exitCode, 1, `${args.join(' ')} must fail`);
      assert.equal(r.body.ok, false);
      assert.match(r.body.error, /expects exactly|must be a number/);
    }
    // negative numbers are numbers (then the viewport check rejects them)
    assert.match(run(['click-at', '-5', '10']).body.error, /outside the viewport/);
    S.expectNothingHeld();
  });
});

// ===========================================================================
// shot
// ===========================================================================

describe('shot: scale, selector, metadata', () => {
  it('shot --scale=css yields an image of exactly the viewport size; device scale is viewport x dpr', () => {
    S.reset('canvas');
    const css = S.ok(['shot', 'css', '--scale=css']);
    const m = S.metrics();
    assert.deepEqual(css.imageSize, { width: m.w, height: m.h });
    assert.equal(css.scale, 'css');
    assert.deepEqual(css.viewport, { width: m.w, height: m.h });
    assert.equal(css.dpr, m.dpr);
    assert.deepEqual(css.scroll, { x: 0, y: 0 });
    const dev = S.ok(['shot', 'dev']);
    assert.equal(dev.scale, 'device');
    near(dev.imageSize.width, m.w * m.dpr, 1.5, 'device width');
    near(dev.imageSize.height, m.h * m.dpr, 1.5, 'device height');
    assert.ok(fs.statSync(dev.path).size > 1000);
    assert.match(S.bad(['shot', 'x', '--scale=huge']).error, /bad --scale/);
  });

  it('shot --selector: clip is the element box, image is box x dpr', () => {
    S.reset('canvas');
    const box = S.rect('#btn');
    const r = S.ok(['shot', 'el', '--selector=#btn']);
    const dpr = S.metrics().dpr;
    near(r.clip.x, box.x, 1); near(r.clip.y, box.y, 1); near(r.clip.width, box.width, 1); near(r.clip.height, box.height, 1);
    near(r.imageSize.width, box.width * dpr, 2, 'element image width');
    near(r.imageSize.height, box.height * dpr, 2, 'element image height');
    const rc = S.ok(['shot', 'elcss', '--selector=#btn', '--scale=css']);
    near(rc.imageSize.width, box.width, 1.5);
    const e = S.bad(['shot', 'x', '--fullPage', '--selector=#btn']);
    assert.match(e.error, /mutually exclusive/);
  });

  it('shot --fullPage covers the whole document; element offsets measured on an element shot map back with --space=screenshot', () => {
    S.reset('tall');
    const full = S.ok(['shot', 'full', '--fullPage']);
    assert.ok(full.imageSize.height > S.metrics().h * full.dpr * 2, 'full page is taller than the viewport');
    // measure an offset on an ELEMENT screenshot and click it: css offset = px / dpr
    S.reset('canvas');
    const el = S.ok(['shot', 'btnshot', '--selector=#btn']);
    const box = S.rect('#btn');
    S.clearLog();
    S.ok(['click', '#btn', `--at=${20 * el.dpr},${10 * el.dpr}`, '--space=screenshot', '--exact=true']);
    const md = mouseLog(S.log())[0];
    near(md[2], box.x + 20, 0.6); near(md[3], box.y + 10, 0.6);
  });
});

// ===========================================================================
// drag
// ===========================================================================

describe('drag, drag-at, mouse-down/up', () => {
  it('HTML5 drag-and-drop between elements: dragstart/dragenter/dragover/drop/dragend fire, payload delivered, mode html5', () => {
    S.reset('dnd');
    const r = S.ok(['drag', '#src', '#dst']);
    assert.equal(r.mode, 'html5');
    assert.equal(r.hitFrom.id, 'src');
    assert.equal(r.hitFrom.draggable, true);
    assert.equal(r.hitTo.id, 'dst');
    assert.ok(r.durationMs > 300);
    const log = S.log();
    assert.deepEqual(log.map((e) => e[0]), ['dragstart', 'dragenter', 'drop', 'dragend']);
    assert.equal(log[0][1], true, 'trusted dragstart');
    const drop = log.find((e) => e[0] === 'drop');
    assert.equal(drop[1], true, 'trusted drop');
    assert.equal(drop[2], 'payload-123', 'dataTransfer payload delivered');
    assert.ok(drop[3] > 2, `dragover fired while moving (${drop[3]})`);
    S.expectNothingHeld();
  });

  it('HTML5 drag with offsets (--from-at / --to-at) and the default-draggable <img> route to html5 too', () => {
    S.reset('dnd');
    const src = S.rect('#src'), dst = S.rect('#dst');
    const r = S.ok(['drag', '#src', '#dst', '--from-at=10,10', '--to-at=100,60', '--exact=true']);
    near(r.from.css.x, src.x + 10, 0.1); near(r.to.css.x, dst.x + 100, 0.1); near(r.to.css.y, dst.y + 60, 0.1);
    assert.equal(r.mode, 'html5');
    S.clearLog();
    const img = S.ok(['drag', '#pic', '#dst']);
    assert.equal(img.mode, 'html5');
    assert.equal(img.hitFrom.draggable, true, 'img is draggable by default');
    assert.ok(S.log().some((e) => e[0] === 'drop'), 'the image was dropped on the target');
  });

  it('a non-draggable source routes to POINTER mode: no dragstart, buttons=1 pointermoves, slider value changes', () => {
    S.reset('slider');
    const thumb = S.center('#thumb');
    const track = S.rect('#track');
    const r = S.ok(['drag', '#thumb', '#track', `--to-at=${track.width - 12},12`]);
    assert.equal(r.mode, 'pointer');
    assert.equal(r.hitFrom.id, 'thumb');
    assert.equal(r.hitFrom.draggable, false);
    const ds = S.evalJson('({v: +document.documentElement.dataset.value, moves: +document.documentElement.dataset.moves, lb: document.documentElement.dataset.lastButtons, mc: +document.documentElement.dataset.maxCoalesced})');
    assert.ok(ds.v > 90, `slider value ${ds.v}`);
    assert.ok(ds.moves >= 5, `pointermoves with the button held: ${ds.moves}`);
    assert.equal(ds.lb, '1', 'buttons=1 on the pointermoves');
    assert.ok(ds.mc > 1, `coalesced events present during a held drag (${ds.mc})`);
    assert.ok(thumb.x < track.x + 30);
    S.expectNothingHeld();
  });

  it('drag-at: pointer mode on a slider thumb and html5 mode on a draggable, by viewport points', () => {
    S.reset('slider');
    const t = S.center('#thumb'), tr = S.rect('#track');
    const r = S.ok(['drag-at', String(Math.round(t.x)), String(Math.round(t.y)), String(Math.round(tr.x + tr.width / 2)), String(Math.round(t.y))]);
    assert.equal(r.mode, 'pointer');
    assert.equal(r.hitFrom.id, 'thumb');
    const v = +S.eval('document.documentElement.dataset.value');
    assert.ok(v > 35 && v < 65, `thumb dragged to the middle: ${v}`);
    S.reset('dnd');
    const s = S.center('#src'), d = S.center('#dst');
    const r2 = S.ok(['drag-at', String(Math.round(s.x)), String(Math.round(s.y)), String(Math.round(d.x)), String(Math.round(d.y))]);
    assert.equal(r2.mode, 'html5');
    assert.ok(S.log().some((e) => e[0] === 'drop' && e[2] === 'payload-123'));
    // a non-draggable element on the dnd page: pointer mode, nothing is dragged
    S.clearLog();
    const nd = S.center('#nodrag');
    const r3 = S.ok(['drag-at', String(Math.round(nd.x)), String(Math.round(nd.y)), String(Math.round(d.x)), String(Math.round(d.y))]);
    assert.equal(r3.mode, 'pointer');
    assert.equal(S.log().filter((e) => e[0] === 'dragstart').length, 0);
    S.expectNothingHeld();
  });

  it('mouse-down + hover-at + mouse-up compose a manual drag; an HTML5 source is detected at mouse-down; state persists across commands', () => {
    S.reset('dnd');
    const s = S.center('#src'), d = S.center('#dst');
    S.ok(['hover-at', String(Math.round(s.x)), String(Math.round(s.y)), '--exact=true']);
    const down = S.ok(['mouse-down']);
    assert.equal(down.hit.id, 'src');
    assert.deepEqual(S.held(), { buttons: ['left'], keys: [] }, 'the hold is visible in pages');
    S.ok(['hover-at', String(Math.round(d.x)), String(Math.round(d.y))]);
    assert.deepEqual(S.held().buttons, ['left'], 'still held across commands');
    const up = S.ok(['mouse-up']);
    assert.equal(up.wasHeld, true);
    const log = S.log();
    assert.deepEqual(log.map((e) => e[0]), ['dragstart', 'dragenter', 'drop', 'dragend']);
    S.expectNothingHeld();
    assert.equal(S.ok(['mouse-up']).wasHeld, false, 'mouse-up when nothing is held is a no-op');
    assert.match(S.bad(['mouse-down', '--button=banana']).error, /bad --button/);
  });

  it('raw drag (Playwright dragTo / mouse steps) works for html5 and pointer drags', () => {
    S.reset('dnd');
    const r = S.ok(['drag', '#src', '#dst', '--raw=true']);
    assert.equal(r.raw, true);
    assert.ok(S.log().some((e) => e[0] === 'drop' && e[2] === 'payload-123'));
    S.reset('slider');
    const t = S.center('#thumb'), tr = S.rect('#track');
    const r2 = S.ok(['drag-at', String(Math.round(t.x)), String(Math.round(t.y)), String(Math.round(tr.x + tr.width - 14)), String(Math.round(t.y)), '--raw=true']);
    assert.equal(r2.raw, true);
    assert.ok(+S.eval('document.documentElement.dataset.value') > 90);
    assert.match(S.bad(['drag', '#thumb', '#track', '--raw=true', '--button=right']).error, /only the left button/);
    S.expectNothingHeld();
  });

  it('drag --modifiers holds the modifier for the whole gesture and releases it after the button', () => {
    S.reset('canvas');
    const cv = S.rect('#cv');
    S.ok(['drag-at', String(Math.round(cv.x + 40)), String(Math.round(cv.y + 40)), String(Math.round(cv.x + 300)), String(Math.round(cv.y + 150)), '--modifiers=Shift']);
    const seq = S.log().filter((e) => e[0] === 'k' || (e[0] === 'm' && (e[1] === 'mousedown' || e[1] === 'mouseup'))).map((e) => (e[0] === 'k' ? `${e[1]}:${e[3]}` : `${e[1]}${e[8] ? ':shift' : ''}`));
    assert.deepEqual(seq, ['keydown:ShiftLeft', 'mousedown:shift', 'mouseup:shift', 'keyup:ShiftLeft']);
    const stats = JSON.parse(S.eval('document.getElementById("stats").textContent'));
    assert.deepEqual(stats.buttonsSeen.filter((b) => b), [1], 'pointermoves during the drag carried buttons=1');
    assert.deepEqual(stats.pressures.filter((p) => p), [0.5], 'and the pressure of a held button');
    assert.ok(stats.withButtons > 3 && stats.shiftMoves >= stats.withButtons - 1, `the held modifier is stamped on the raw pointer bursts too (${stats.shiftMoves}/${stats.withButtons} moves had shiftKey)`);
    S.expectNothingHeld('after a modifier drag');
  });
});

// ===========================================================================
// scroll
// ===========================================================================

describe('scroll: containers, quantised wheel, targets', () => {
  it('B2: scrolls an inner panel whose document does not scroll — >= 90% of 3000px, container reported', () => {
    S.reset('scroll');
    const r = S.ok(['scroll', '3000', '--target=#panel']);
    const top = +S.eval('document.getElementById("panel").scrollTop');
    assert.ok(top >= 2700, `panel scrolled ${top}px of 3000 (the old code stopped at ~450)`);
    assert.equal(+S.eval('document.scrollingElement.scrollTop'), 0, 'the document did not scroll');
    assert.equal(r.container.id, 'panel');
    assert.equal(r.container.isDocument, false);
    assert.equal(r.axis, 'y');
    assert.equal(r.before.y, 0);
    assert.equal(r.after.y, top);
    near(r.scrolledBy, top, 0.5, 'scrolledBy = the container\'s real movement');
  });

  it('the wheel is quantised like a mouse: whole 100px notches, deltaMode 0, trusted, 15-40ms inside a flick', () => {
    S.reset('scroll');
    const r = S.ok(['scroll', '1200', '--target=#panel']);
    const w = S.log().filter((e) => e[0] === 'w');
    assert.ok(w.length >= 6, `${w.length} wheel events`);
    assert.ok(w.every((e) => e[1] === 0 && e[2] % 100 === 0 && e[2] >= 100 && e[3] === 0 && e[4] === true), 'multiples of 100, pixel mode, trusted');
    assert.ok(w.filter((e) => e[2] > 100).length < w.length / 2, 'multi-notch events are occasional');
    near(r.scrolledBy, 1200, 100, 'the request lands within one notch');
    assert.equal(r.wheelModel, 'default');
    assert.equal(r.quantum, 100);
    // Chrome merges wheel events that reach the page within one frame (16.7 ms; deltas add up), so the page can see a few fewer events
    // than were dispatched - never more
    assert.ok(w.length <= r.events && w.length >= r.events - Math.ceil(r.events * 0.25), `the page saw ${w.length} of the ${r.events} dispatched wheel events`);
    // a small request is still one whole notch (no partial notches)
    S.clearLog();
    const r2 = S.ok(['scroll', '30', '--target=#panel']);
    assert.equal(S.log().filter((e) => e[0] === 'w').length, 1);
    assert.equal(r2.scrolledBy, 100, 'reports the ACTUAL distance moved');
  });

  it('scroll right moves a horizontal scroller; --dx gives an explicit horizontal amount; left goes back', () => {
    S.reset('scroll');
    const r = S.ok(['scroll', 'right', '--target=#hs']);
    assert.equal(r.axis, 'x');
    assert.equal(r.container.id, 'hs');
    near(r.scrolledBy, 600, 100);
    const x1 = +S.eval('document.getElementById("hs").scrollLeft');
    assert.ok(x1 >= 500);
    const r2 = S.ok(['scroll', '--dx=300', '--target=#hs']);
    assert.equal(r2.axis, 'x');
    near(+S.eval('document.getElementById("hs").scrollLeft') - x1, 300, 100);
    const r3 = S.ok(['scroll', 'left', '--dx=200', '--target=#hs']);
    assert.ok(r3.scrolledBy < 0 && r3.scrolledBy >= -300);
    assert.match(S.bad(['scroll', 'down', '--dx=100']).error, /--dx is a horizontal amount/);
  });

  it('scroll --target moves the pointer into the element first; --x/--y moves it to a point; without either the wheel stays at the pointer', () => {
    S.reset('scroll');
    S.ok(['scroll', '300', '--target=#side']);
    const sideTop = +S.eval('document.getElementById("side").scrollTop');
    assert.ok(sideTop >= 200, `#side scrolled ${sideTop}`);
    const side = S.rect('#side');
    const p = S.pointer();
    assert.ok(p.x >= side.x && p.x <= side.x + side.width && p.y >= side.y && p.y <= side.y + side.height, 'the pointer was moved into #side');
    // same pointer, no target: the SAME container scrolls on
    S.ok(['scroll', '300']);
    assert.ok(+S.eval('document.getElementById("side").scrollTop') > sideTop);
    assert.equal(+S.eval('document.getElementById("panel").scrollTop'), 0, 'the panel was never touched');
    // explicit point
    const panel = S.rect('#panel');
    S.ok(['scroll', '300', `--x=${Math.round(panel.x + 100)}`, `--y=${Math.round(panel.y + 100)}`]);
    assert.ok(+S.eval('document.getElementById("panel").scrollTop') >= 200);
    assert.match(S.bad(['scroll', 'down', '--x=100']).error, /--x and --y go together/);
  });

  it('top / bottom scroll the container under the pointer to its edges', () => {
    S.reset('scroll');
    const bottom = S.ok(['scroll', 'bottom', '--target=#side']);
    const max = +S.eval('document.getElementById("side").scrollHeight - document.getElementById("side").clientHeight');
    near(+S.eval('document.getElementById("side").scrollTop'), max, 1, 'reached the bottom edge');
    assert.equal(bottom.requested, 'edge');
    const top = S.ok(['scroll', 'top']);
    assert.equal(+S.eval('document.getElementById("side").scrollTop'), 0);
    assert.ok(top.scrolledBy < 0);
    assert.equal(top.container.id, 'side');
  });

  it('a document that scrolls still works, with edge detection (bottom stops at the end)', () => {
    S.reset('tall');
    const m = S.metrics();
    S.ok(['hover-at', String(Math.round(m.w / 2)), String(Math.round(m.h / 2))]);
    const r = S.ok(['scroll', 'down']);
    assert.equal(r.container.isDocument, true);
    near(r.scrolledBy, 600, 100);
    const b = S.ok(['scroll', 'bottom']);
    const max = +S.eval('document.scrollingElement.scrollHeight - innerHeight');
    near(+S.eval('scrollY'), max, 2, 'document bottom');
    assert.equal(b.container.isDocument, true);
    const again = S.ok(['scroll', 'down']);
    assert.equal(again.scrolledBy, 0, 'already at the edge: nothing moves');
    assert.ok(again.events <= 12, `edge detection stops quickly (${again.events} events)`);
  });

  it('a box with only a wheel handler (nothing natively scrollable) still receives the wheel events', () => {
    S.reset('scroll');
    const r = S.ok(['scroll', '300', '--target=#lock']);
    assert.equal(r.scrollable, false);
    assert.equal(r.scrolledBy, 0);
    // wheel events reach the page rAF-aligned: give them a moment, and report both counters if they do not arrive
    let counts;
    for (let i = 0; i < 10; i++) {
      counts = S.evalJson('({lock: +document.documentElement.dataset.lockWheels || 0, all: +document.documentElement.dataset.wheels || 0, visibility: document.visibilityState})');
      if (counts.lock >= 1 && counts.lock === counts.all) break;
    }
    // (how many events the plan has is random - a 300 px request can be 3 notches or a 100 and a 200 - and Chrome merges events that reach the page
    // within one frame; what matters is that the box got the wheel at all, and that nothing went anywhere else)
    assert.ok(r.events >= 1 && counts.lock >= 1 && counts.lock === counts.all, `the handler box received ${counts.lock} wheel events (page total ${counts.all}, visibility ${counts.visibility}, pointer ${JSON.stringify(S.pointer())}, events dispatched ${r.events})`);
  });

  it('--raw scroll sets the container position directly (no wheel events)', () => {
    S.reset('scroll');
    const before = S.log().length;
    const r = S.ok(['scroll', '700', '--target=#panel', '--raw=true']);
    assert.equal(r.scrolledBy, 700);
    assert.equal(+S.eval('document.getElementById("panel").scrollTop'), 700);
    assert.equal(S.log().filter((e) => e[0] === 'w').length, 0);
    const e = S.ok(['scroll', 'bottom', '--raw=true', '--target=#panel']);
    assert.ok(e.after.y > 5000);
    assert.equal(before, 0);
  });
});

// ===========================================================================
// keys
// ===========================================================================

describe('press, hold, key-down/up, release, type-focused', () => {
  const kseq = (log) => keyLog(log).map((e) => `${e[1] === 'keydown' ? 'v' : '^'}${e[3]}${e[7] ? ' ctrl' : ''}${e[6] ? ' shift' : ''}`);

  it('press Control+A: ControlLeft down -> KeyA down (ctrlKey) -> KeyA up -> ControlLeft up, no Shift in the stream', () => {
    S.reset('canvas');
    S.ok(['press', 'Control+A']);
    assert.deepEqual(kseq(S.log()), ['vControlLeft ctrl', 'vKeyA ctrl', '^KeyA ctrl', '^ControlLeft']);
    S.expectNothingHeld();
  });

  it('press Control+Shift+ArrowLeft presses modifiers in order and releases them in reverse', () => {
    S.reset('canvas');
    S.ok(['press', 'Control+Shift+ArrowLeft']);
    assert.deepEqual(kseq(S.log()), ['vControlLeft ctrl', 'vShiftLeft ctrl shift', 'vArrowLeft ctrl shift', '^ArrowLeft ctrl shift', '^ShiftLeft ctrl', '^ControlLeft']);
    // the dwell of the main key is real time between the two dispatches (Chrome stamps them), a continuous value
    const k = keyLog(S.log()).filter((e) => e[3] === 'ArrowLeft');
    const dwell = k[1][11] - k[0][11];
    assert.ok(dwell > 20 && dwell < 400, `dwell ${dwell}`);
  });

  it('press a --hold=1200 auto-repeats after ~500 ms with repeat:true every ~33 ms, and the held key keeps typing', () => {
    S.reset('keys');
    S.ok(['click', '#in']);
    S.clearLog();
    const r = S.ok(['press', 'a', '--hold=1200']);
    const downs = keyLog(S.log()).filter((e) => e[1] === 'keydown');
    assert.equal(downs[0][5], false, 'the first keydown is not a repeat');
    const reps = downs.filter((e) => e[5] === true);
    assert.ok(reps.length >= 12 && reps.length <= 30, `${reps.length} auto-repeats`);
    assert.equal(r.autoRepeats, reps.length);
    const delay = reps[0][11] - downs[0][11];
    assert.ok(delay >= 400 && delay <= (CI ? 900 : 700), `autorepeat delay ${delay.toFixed(0)} ms (~500)`);
    const gaps = reps.slice(1).map((e, i) => e[11] - reps[i][11]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(mean > 28 && mean < (CI ? 55 : 40), `repeat interval ${mean.toFixed(1)} ms (~33)`);
    assert.equal(S.eval('document.getElementById("in").value'), 'a'.repeat(1 + reps.length), 'held printable keys keep typing, like real hardware');
    const ups = keyLog(S.log()).filter((e) => e[1] === 'keyup');
    assert.equal(ups.length, 1);
    S.expectNothingHeld();
  });

  it('press --repeat=3 presses three times with human gaps', () => {
    S.reset('canvas');
    S.ok(['press', 'ArrowDown', '--repeat=3']);
    const ks = keyLog(S.log());
    assert.deepEqual(ks.map((e) => e[1]), ['keydown', 'keyup', 'keydown', 'keyup', 'keydown', 'keyup']);
    assert.ok(ks[2][11] - ks[0][11] > 60, 'gaps between presses');
    assert.ok(ks.every((e) => e[5] === false), 'separate presses are not repeats');
  });

  it('key-down Shift persists across commands; a click-at while it is held has shiftKey true; key-up releases it', () => {
    S.reset('canvas');
    const kd = S.ok(['key-down', 'Shift']);
    assert.deepEqual(kd.held, { buttons: [], keys: ['Shift'] });
    assert.deepEqual(S.held().keys, ['Shift'], 'visible in pages');
    const b = S.center('#btn');
    S.ok(['click-at', String(Math.round(b.x)), String(Math.round(b.y))]);
    const md = mouseLog(S.log()).find((e) => e[1] === 'mousedown');
    assert.equal(md[8], true, 'mousedown.shiftKey while Shift is held');
    assert.deepEqual(S.held().keys, ['Shift'], 'the click did not release the explicit Shift');
    const ku = S.ok(['key-up', 'Shift']);
    assert.equal(ku.wasHeld, true);
    S.expectNothingHeld();
    const ks = keyLog(S.log()).map((e) => `${e[1]}:${e[3]}`);
    assert.deepEqual(ks, ['keydown:ShiftLeft', 'keyup:ShiftLeft'], 'exactly one down and one up');
    assert.equal(S.ok(['key-up', 'Shift']).wasHeld, false, 'key-up of a key that is not held is a no-op');
  });

  it('release clears every held button and key, in reverse order, and zeroes the modifier mask', () => {
    S.reset('canvas');
    S.ok(['key-down', 'Shift']);
    S.ok(['key-down', 'Control']);
    S.ok(['hover-at', '120', '120', '--exact=true']);
    S.ok(['mouse-down']);
    S.ok(['key-down', 'ArrowRight']);
    assert.deepEqual(S.held(), { buttons: ['left'], keys: ['Shift', 'Control', 'ArrowRight'] });
    const r = S.ok(['release']);
    assert.deepEqual(r.released.keys, ['ArrowRight', 'Control', 'Shift'], 'reverse order of pressing');
    assert.deepEqual(r.released.buttons, ['left']);
    assert.equal(r.modifiers, 0);
    S.expectNothingHeld();
    const log = S.log();
    const ups = log.filter((e) => (e[0] === 'k' && e[1] === 'keyup') || (e[0] === 'm' && e[1] === 'mouseup')).map((e) => (e[0] === 'k' ? e[3] : 'mouseup'));
    assert.deepEqual(ups, ['ArrowRight', 'mouseup', 'ControlLeft', 'ShiftLeft'], 'the mouse button went up in its place in the reverse order');
    // after release a click has no modifiers
    S.clearLog();
    S.ok(['click-at', '120', '120']);
    assert.equal(mouseLog(S.log())[0][8], false);
  });

  it('a button that is already held cannot be pressed again (click-at while mouse-down is an error)', () => {
    S.reset('canvas');
    S.ok(['hover-at', '120', '120', '--exact=true']);
    S.ok(['mouse-down']);
    assert.match(S.bad(['mouse-down']).error, /already held/);
    assert.match(S.bad(['click-at', '130', '130']).error, /already held/);
    assert.deepEqual(S.held().buttons, ['left'], 'the original hold is intact');
    S.ok(['release']);
    S.expectNothingHeld();
  });

  it('key-down with an unknown key is a clear error; named keys, F-keys and single chars are accepted', () => {
    S.reset('canvas');
    const e = S.bad(['key-down', 'Nonsense']);
    assert.match(e.error, /unknown key 'Nonsense'/);
    assert.match(e.error, /ArrowUp\/Down\/Left\/Right/);
    for (const k of ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'Space', 'F1', 'F12', 'a', '5', 'Alt', 'Meta']) {
      S.ok(['key-down', k, '--raw=true']);        // --raw skips the human pauses: this loop only checks the vocabulary
      S.ok(['key-up', k, '--raw=true']);
    }
    S.expectNothingHeld();
    // a capital needs Shift: both are held (and visible) until released
    assert.deepEqual(S.ok(['key-down', 'A']).held.keys, ['Shift', 'A']);
    S.ok(['release']);
    S.expectNothingHeld();
  });

  it('type-focused types into the focused input and reports what was focused; with nothing focused the keys still dispatch', () => {
    S.reset('keys');
    S.ok(['click', '#in']);
    S.clearLog();
    const r = S.ok(['type-focused', 'hello World 42', '--typos=off']);
    assert.deepEqual(r.focused, { tag: 'input', editable: true });
    assert.equal(r.typed, 14);
    assert.equal(S.eval('document.getElementById("in").value'), 'hello World 42');
    // explicit Shift before the capital W, balanced
    const ks = keyLog(S.log()).filter((e) => e[3] === 'ShiftLeft').map((e) => e[1]);
    assert.deepEqual(ks, ['keydown', 'keyup']);
    // nothing editable focused: canvas-style key listeners on window still see the keys
    S.reset('canvas');
    S.clearLog();
    const r2 = S.ok(['type-focused', 'wasd', '--typos=off']);
    assert.equal(r2.focused.editable, false);
    assert.deepEqual(keyLog(S.log()).filter((e) => e[1] === 'keydown').map((e) => e[3]), ['KeyW', 'KeyA', 'KeyS', 'KeyD']);
  });

  it('with Shift held explicitly, typing never presses/releases that Shift and yields shifted characters', () => {
    S.reset('keys');
    S.ok(['click', '#in']);
    S.ok(['key-down', 'Shift']);
    S.clearLog();
    S.ok(['type-focused', 'ab', '--typos=off']);
    assert.equal(S.eval('document.getElementById("in").value'), 'AB');
    const shiftEvents = keyLog(S.log()).filter((e) => e[3] === 'ShiftLeft');
    assert.deepEqual(shiftEvents, [], 'the engine did not touch the explicit Shift');
    assert.deepEqual(S.held().keys, ['Shift']);
    S.ok(['release']);
    S.expectNothingHeld();
  });

  it('B3: --typos=off produces zero Backspace keydowns on a ~120 char text (seeded); --typos=on makes seeded corrections; bad values are rejected', () => {
    const human = require('../src/human');
    const text = 'the quick brown fox jumps over the lazy dog and keeps running through the green meadow until the sun goes down behind hills';
    // a seed that (in this exact code path) yields corrections: found without a browser, via the mocked engine
    const fakePage = () => {
      const ev = [];
      const cdp = { async send(m, p) { ev.push(p); } };
      return { ev, page: { async evaluate() { return false; }, context() { return { newCDPSession: async () => cdp }; }, keyboard: { async down() {}, async up() {}, async press() {}, async insertText() {} }, viewportSize() { return null; } } };
    };
    // the human pauses go through timing.preciseSleep, which really waits: run the mocked engine in VIRTUAL time (a sleep only moves a clock)
    const timing = require('../src/timing');
    const fastTimers = async (fn) => { timing._useVirtualClock(true); try { return await fn(); } finally { timing._useVirtualClock(false); } };
    let seed = -1;
    return (async () => {
      for (let s = 1; s <= 400 && seed < 0; s++) {
        const f = fakePage();
        await fastTimers(() => human.humanType(f.page, text, { rng: human.makeRng(s), typos: 'on' }));
        if (f.ev.some((e) => e.code === 'Backspace')) seed = s;
      }
      assert.ok(seed > 0, 'a seed with corrections exists');
      S.reset('keys');
      S.ok(['click', '#ta']);
      S.clearLog();
      S.ok(['type-focused', text, '--typos=off', `--seed=${seed}`], { timeout: 180_000 });
      assert.equal(keyLog(S.log()).filter((e) => e[1] === 'keydown' && e[3] === 'Backspace').length, 0, '--typos=off: zero Backspace keydowns');
      assert.equal(S.eval('document.getElementById("ta").value'), text);
      S.eval('document.getElementById("ta").value = "", 1');
      S.clearLog();
      S.ok(['type-focused', text, '--typos=on', `--seed=${seed}`], { timeout: 180_000 });
      assert.ok(keyLog(S.log()).filter((e) => e[1] === 'keydown' && e[3] === 'Backspace').length >= 1, `--typos=on (seed ${seed}) corrects at least one typo`);
      assert.equal(S.eval('document.getElementById("ta").value'), text, 'corrections end with the intended text');
      assert.match(S.bad(['type-focused', 'x', '--typos=maybe']).error, /bad --typos/);
      assert.match(S.bad(['fill', '#in', 'x', '--typos=maybe']).error, /bad --typos/);
      S.ok(['fill', '#in', 'short fill', '--typos=off']);     // fill forwards the flag too
      assert.equal(S.eval('document.getElementById("in").value'), 'short fill');
    })();
  });

  it('--raw stays robotic: press --raw uses Playwright\'s keyboard; click-at --raw makes no human path', () => {
    S.reset('canvas');
    S.ok(['press', 'Control+A', '--raw=true']);
    assert.deepEqual(kseq(S.log()), ['vControlLeft ctrl', 'vKeyA ctrl', '^KeyA ctrl', '^ControlLeft']);
    S.clearLog();
    const cv = S.rect('#cv');
    const x = Math.round(cv.x + 200), y = Math.round(cv.y + 100);
    const r = S.ok(['click-at', String(x), String(y), '--raw=true']);
    assert.equal(r.raw, true);
    const stats = JSON.parse(S.eval('document.getElementById("stats").textContent'));
    assert.ok(stats.n <= 2, `raw click makes at most a couple of moves (${stats.n})`);
    for (const e of mouseLog(S.log())) near(e[2], x, 0.01, 'raw click is exact');
    S.expectNothingHeld();
  });

  it('no touch events are produced anywhere by the mouse/keyboard layer (the fingerprint is a mouse-only desktop)', () => {
    S.reset('canvas');
    const cv = S.rect('#cv');
    S.ok(['click-at', String(Math.round(cv.x + 50)), String(Math.round(cv.y + 50))]);
    S.ok(['drag-at', String(Math.round(cv.x + 50)), String(Math.round(cv.y + 50)), String(Math.round(cv.x + 300)), String(Math.round(cv.y + 150))]);
    S.ok(['scroll', '300', '--target=#cv']);
    S.ok(['press', 'Enter']);
    assert.equal(S.log().filter((e) => e[0] === 't').length, 0, 'no touchstart/touchend');
    assert.equal(S.eval('document.documentElement.dataset.touchmoves === undefined'), true, 'no touchmove');
    assert.equal(S.eval('navigator.maxTouchPoints'), 0);
    assert.equal(S.eval('"ontouchstart" in window'), false);
    assert.equal(JSON.parse(S.eval('document.getElementById("stats").textContent')).pointerTypes.every((t) => t === 'mouse'), true);
  });
});

// ===========================================================================
// keyboard layouts (Russian)
// ===========================================================================

describe('keyboard layout fidelity (EN <-> RU)', () => {
  it('typing Russian: physical codes, capitals with Shift, a human layout-switch chord, emoji via insertText', () => {
    const f = new Session(MAIN);
    f.newPage('layouts');
    try {
      f.go('keys');
      f.ok(['click', '#in']);
      f.clearLog();
      const r = f.ok(['type-focused', 'Hi Мир! 😀 ok', '--typos=off', '--seed=4'], { timeout: 180_000 });
      assert.equal(f.eval('document.getElementById("in").value'), 'Hi Мир! 😀 ok');
      assert.equal(r.typed, 12);
      const ks = keyLog(f.log());
      const downs = ks.filter((e) => e[1] === 'keydown');
      assert.ok(downs.every((e) => e[3] && e[4] > 0), 'every keydown has a real code and keyCode (no empty-code fallback keydowns)');
      // the chord: Alt down, Shift down, (Shift up, Alt up) happens before the first Cyrillic key and again before "ok"
      const order = downs.map((e) => e[3]);
      const iM = order.indexOf('KeyV');                       // М = Shift+KeyV on the Russian layout
      const chord1 = order.slice(0, iM);
      assert.ok(chord1.includes('AltLeft'), 'an Alt press before the Russian word');
      assert.ok(chord1.lastIndexOf('AltLeft') < iM);
      const mir = downs.filter((e) => ['М', 'и', 'р'].includes(e[2]));
      assert.deepEqual(mir.map((e) => e[3]), ['KeyV', 'KeyB', 'KeyH']);
      assert.deepEqual(mir.map((e) => e[4]), [86, 66, 72], 'keyCode = the physical key\'s virtual key code');
      const bang = downs.find((e) => e[2] === '!');
      assert.equal(bang[3], 'Digit1');
      assert.equal(bang[6], true, "'!' on the Russian layout is Shift+Digit1");
      assert.equal(downs.some((e) => e[2] === '😀'), false, 'emoji have no keydown');
      assert.equal(downs.filter((e) => e[3] === 'AltLeft').length, 2, 'one chord to Russian, one back to English');
      assert.equal(f.pageInfo().input.layout, 'en');
      f.expectNothingHeld('after layout chords');
    } finally { f.ok(['close']); }
  });

  it('a char typable on both layouts uses the ACTIVE layout\'s key (no switch); the layout persists per page', () => {
    const f = new Session(MAIN);
    f.newPage('layouts2');
    try {
      f.go('keys');
      f.ok(['click', '#in']);
      f.clearLog();
      f.ok(['type-focused', 'а.б,в', '--typos=off', '--seed=2'], { timeout: 120_000 });     // typed on the Russian layout
      assert.equal(f.eval('document.getElementById("in").value'), 'а.б,в');
      const downs = keyLog(f.log()).filter((e) => e[1] === 'keydown');
      assert.equal(downs.find((e) => e[2] === '.')[3], 'Slash', "RU '.' is the Slash key");
      const comma = downs.find((e) => e[2] === ',');
      assert.equal(comma[3], 'Slash');
      assert.equal(comma[6], true, "RU ',' is Shift+Slash");
      assert.equal(f.pageInfo().input.layout, 'ru', 'the layout stays Russian after typing Russian text');
      // a shortcut is pressed by position: no layout switch for Control+A while the layout is Russian
      f.clearLog();
      f.ok(['press', 'Control+A']);
      assert.deepEqual(keyLog(f.log()).map((e) => `${e[1]}:${e[3]}`), ['keydown:ControlLeft', 'keydown:KeyA', 'keyup:KeyA', 'keyup:ControlLeft']);
      const keyA = keyLog(f.log()).find((e) => e[3] === 'KeyA')[2];
      if (process.platform === 'darwin') {
        // macOS presses shortcut chords through Playwright's keyboard (the CDP emitter does not trigger Cmd/Ctrl editing commands
        // there), which names the key by its US-layout character: the physical key (code KeyA, asserted above) is right, `key` is 'a'
        // (measured: this assertion failed with 'a' on macOS in CI)
        assert.ok(keyA === 'a' || keyA === 'ф', `Ctrl+A on macOS reports the key as ${JSON.stringify(keyA)}`);
      } else {
        assert.equal(keyA, 'ф', 'Ctrl+A on the Russian layout is the key that types ф');
      }
    } finally { f.ok(['close']); }
  });
});

// ===========================================================================
// native <select>
// ===========================================================================

describe('select: native <select> driven like a person', () => {
  const sel = (log) => log.filter((e) => e[0] === 'input' || e[0] === 'change');

  it('single select: real click, ArrowDown steps (disabled option skipped), Enter; trusted input+change', (t) => {
    S.reset('keys');
    const r = S.ok(['select', '#sel', 'Elderberry']);
    assert.deepEqual(r.selected, ['e']);
    if (process.platform === 'darwin' && r.method === 'fallback') {
      // in CI's headless Chromium on macOS the key walk did not take effect (measured; probably because macOS lists a select as a
      // native menu and an arrow key on a closed select opens it - a guess), so the command fell back to selectOption - reported
      // honestly as method 'fallback', with the right value. The key walk itself is asserted on Windows and Linux.
      t.diagnostic(`macOS: the key walk fell back to selectOption (${r.reason})`);
      assert.equal(S.eval('document.getElementById("sel").value'), 'e');
      S.expectNothingHeld();
      return;
    }
    assert.equal(r.method, 'keyboard');
    assert.equal(r.steps, 3, 'Banana, (Cherry is disabled: skipped), Date, Elderberry');
    const ev = sel(S.log());
    assert.deepEqual(ev.map((e) => e[0]), ['input', 'change']);
    assert.ok(ev.every((e) => e[1] === 'sel' && e[3] === true), 'trusted events');
    // by value, going UP
    S.clearLog();
    const up = S.ok(['select', '#sel', 'b']);
    assert.equal(up.method, 'keyboard');
    assert.equal(up.steps, 2);
    assert.deepEqual(up.selected, ['b']);
    assert.equal(S.eval('document.getElementById("sel").value'), 'b');
    // already selected: nothing to do
    assert.equal(S.ok(['select', '#sel', 'Banana']).method, 'unchanged');
    S.expectNothingHeld();
  });

  it('select multiple: a plain click for the first option, Ctrl-click for the others', () => {
    S.reset('keys');
    const r = S.ok(['select', '#msel', '["2","4"]']);
    assert.equal(r.method, 'click');
    assert.deepEqual(r.selected, ['2', '4']);
    const md = S.log().filter((e) => e[0] === 'msel-mousedown');
    const mi = process.platform === 'darwin' ? 2 : 1;
    assert.deepEqual(md.map((e) => e[mi]), [false, true], 'Ctrl (Cmd on macOS) held for the second option only');
    S.expectNothingHeld();
  });

  it('errors and --raw: an unknown / disabled option is a clear error; --raw is plain selectOption', () => {
    S.reset('keys');
    assert.match(S.bad(['select', '#sel', 'nope']).error, /no <option> matches 'nope'/);
    assert.match(S.bad(['select', '#sel', 'c']).error, /disabled/);
    const r = S.ok(['select', '#sel', 'd', '--raw=true']);
    assert.equal(r.method, 'raw');
    assert.deepEqual(r.selected, ['d']);
  });
});

// ===========================================================================
// real clipboard paste
// ===========================================================================

describe('paste: real clipboard paste with a human Ctrl+V (and its safe fallbacks)', () => {
  let clip;

  it('clipboard lock: {pid,page,id,at,hb}, created exclusively; stale locks (dead pid / no heartbeat for 15 s) are reaped; a live fresh lock blocks', async () => {
    clip = require('../src/clipboard');
    // an explicit `file`: this unit test must never touch the real machine-wide lock a live daemon may be holding
    const lockFile = path.join(MAIN.work, 'unit-clipboard.lock');
    const a = await clip.acquireLock({ page: 'p9', file: lockFile });
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.deepEqual(Object.keys(held).sort(), ['at', 'hb', 'id', 'page', 'pid']);
    assert.equal(held.pid, process.pid);
    assert.equal(held.page, 'p9');
    assert.match(held.id, /^[0-9a-f]{16}$/, 'a random id per acquisition');
    assert.ok(Math.abs(Date.now() - held.at) < 5000);
    assert.equal(held.hb, held.at, 'the first heartbeat is the acquisition itself');
    await assert.rejects(() => clip.acquireLock({ waitMs: 500, file: lockFile }), (e) => e.code === 'CLIPBOARD_BUSY' && e.waitedMs >= 450);
    await a.release();
    assert.equal(fs.existsSync(lockFile), false, 'released');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483000, page: 'p1', at: Date.now() }));    // dead owner
    const b = await clip.acquireLock({ waitMs: 2000, file: lockFile });
    assert.ok(b.waitedMs < 1500, 'a lock whose pid is dead is stale');
    await b.release();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, page: 'p1', at: Date.now() - 16_000 }));  // a file without a heartbeat counts from `at`
    const c = await clip.acquireLock({ waitMs: 2000, file: lockFile });
    assert.ok(c.waitedMs < 1500, 'a lock without a heartbeat that is older than 15 s is stale');
    await c.release();
    // a LIVE pid whose last heartbeat is older than staleMs is stale (its holder is frozen / gone); a fresh heartbeat is not,
    // however old the acquisition is
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, page: 'p1', id: 'aaaaaaaaaaaaaaaa', at: Date.now() - 60_000, hb: Date.now() - 16_000 }));
    const d = await clip.acquireLock({ waitMs: 2000, file: lockFile });
    assert.ok(d.waitedMs < 1500, 'a live pid with a heartbeat older than 15 s is stale');
    await d.release();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, page: 'p1', id: 'bbbbbbbbbbbbbbbb', at: Date.now() - 60_000, hb: Date.now() - 200 }));
    await assert.rejects(() => clip.acquireLock({ waitMs: 600, file: lockFile }), (e) => e.code === 'CLIPBOARD_BUSY', 'an old lock with a fresh heartbeat is held');
    fs.rmSync(lockFile, { force: true });
    // exclusive creation: two concurrent acquirers never both win
    const [x, y] = await Promise.allSettled([clip.acquireLock({ waitMs: 400, file: lockFile }), clip.acquireLock({ waitMs: 400, file: lockFile })]);
    assert.equal([x, y].filter((r) => r.status === 'fulfilled').length, 1, 'exactly one of two concurrent acquirers got the lock');
    for (const r of [x, y]) if (r.status === 'fulfilled') await r.value.release();
  });

  it('clipboard lock heartbeat: a LIVE holder in another process is never reaped however long it holds; a holder whose process dies is reaped at once', async () => {
    clip = require('../src/clipboard');
    const lockFile = path.join(MAIN.work, 'heartbeat-clipboard.lock');
    fs.rmSync(lockFile, { force: true });
    const script = `
      const clip = require(${JSON.stringify(path.join(REPO, 'src', 'clipboard.js'))});
      (async () => {
        const l = await clip.acquireLock({ file: process.env.LOCK_FILE, page: 'holder', waitMs: 5000, heartbeatMs: 100 });
        process.stdout.write('held\\n');
        await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS)));
        await l.release();
        process.stdout.write('released\\n');
      })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
    `;
    const holder = (holdMs) => {
      const c = spawn(process.execPath, ['-e', script], { env: { ...process.env, LOCK_FILE: lockFile, HOLD_MS: String(holdMs) }, stdio: ['ignore', 'pipe', 'pipe'] });
      const seen = { held: null, released: null, err: '' };
      seen.heldP = new Promise((resolve) => c.stdout.on('data', (d) => { if (/held/.test(String(d)) && !seen.held) { seen.held = Date.now(); resolve(); } }));
      seen.releasedP = new Promise((resolve) => c.stdout.on('data', (d) => { if (/released/.test(String(d))) { seen.released = Date.now(); resolve(); } }));
      c.stderr.on('data', (d) => { seen.err += d; });
      seen.exited = new Promise((resolve) => c.once('exit', resolve));
      return { c, seen };
    };
    // 1) held for 5 s, a waiter that thinks a lock is stale after 1.5 s of silence: the heartbeats (100 ms) keep it alive
    const h1 = holder(5000);
    await Promise.race([h1.seen.heldP, h1.seen.exited]);
    assert.ok(h1.seen.held, `the holder process acquired the lock: ${h1.seen.err}`);
    const first = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.notEqual(first.pid, process.pid, 'the lock is held by another process');
    await new Promise((r) => setTimeout(r, 450));
    const second = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(second.id, first.id);
    assert.equal(second.at, first.at, 'at stays the acquisition time');
    assert.ok(second.hb > first.hb, `the heartbeat advances (${first.hb} -> ${second.hb})`);
    await assert.rejects(() => clip.acquireLock({ waitMs: 2600, staleMs: 1500, file: lockFile }),
      (e) => e.code === 'CLIPBOARD_BUSY' && e.waitedMs >= 2500, 'a live, heartbeating holder is not reaped although it holds the lock longer than staleMs');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).id, first.id, 'still the holder\'s own lock');
    await h1.seen.releasedP;
    await h1.seen.exited;
    assert.equal(fs.existsSync(lockFile), false, 'the holder released its lock');
    const mine = await clip.acquireLock({ waitMs: 1000, staleMs: 1500, file: lockFile });
    await mine.release();

    // 2) a holder whose process is killed (heartbeat fresh, pid dead) is reaped at once, long before staleMs
    const h2 = holder(60_000);
    await Promise.race([h2.seen.heldP, h2.seen.exited]);
    assert.ok(h2.seen.held, `second holder acquired: ${h2.seen.err}`);
    h2.c.kill();
    await h2.seen.exited;
    const t0 = Date.now();
    const got = await clip.acquireLock({ waitMs: 3000, staleMs: 60_000, file: lockFile });
    assert.ok(Date.now() - t0 < 2000, `a dead holder's lock is reaped at once (${Date.now() - t0} ms), not after staleMs`);
    await got.release();
  });

  it('clipboard lock release: only a lock that is still OURS (by id; pid+at only for a file without an id) is removed, and the heartbeat neither resurrects nor overwrites', async () => {
    clip = require('../src/clipboard');
    const lockFile = path.join(MAIN.work, 'owner-clipboard.lock');
    fs.rmSync(lockFile, { force: true });
    const a = await clip.acquireLock({ page: 'p9', file: lockFile, heartbeatMs: 50 });
    const mineNow = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    // somebody else's lock (same pid and acquisition time, a different id): not ours, never deleted, never touched by our heartbeat
    const foreign = { ...mineNow, id: 'f0f0f0f0f0f0f0f0', hb: mineNow.hb };
    fs.writeFileSync(lockFile, JSON.stringify(foreign));
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), foreign, 'our heartbeat did not overwrite a lock that is no longer ours');
    await a.release();
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), foreign, 'release() with a foreign id does not delete');
    fs.rmSync(lockFile, { force: true });
    // a released lock stays gone: no late heartbeat re-creates the file
    const b = await clip.acquireLock({ file: lockFile, heartbeatMs: 50 });
    await b.release();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(lockFile), false, 'no heartbeat after release');
    // a file without an id (written before the heartbeat existed) is matched by pid + acquisition time
    const c = await clip.acquireLock({ file: lockFile, heartbeatMs: 10_000 });
    const cNow = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    fs.writeFileSync(lockFile, JSON.stringify({ pid: cNow.pid, page: null, at: cNow.at + 1 }));
    await c.release();
    assert.equal(fs.existsSync(lockFile), true, 'an id-less file with another acquisition time is not ours');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: cNow.pid, page: null, at: cNow.at }));
    await c.release();
    assert.equal(fs.existsSync(lockFile), false, 'an id-less file with our pid and acquisition time is');
  });

  it('F1: the lock is machine-wide per OS user (os.tmpdir()), NOT under NATIVEWRIGHT_HOME — processes with different homes resolve the same file and exclude each other', async () => {
    clip = require('../src/clipboard');
    const sharedTmp = process.platform !== 'win32' && process.platform !== 'darwin';
    const expected = path.join(os.tmpdir(), sharedTmp && typeof process.getuid === 'function' ? `nativewright-clipboard-${process.getuid()}.lock` : 'nativewright-clipboard.lock');
    assert.equal(clip.lockPath(), expected);
    assert.ok(!clip.lockPath().startsWith(MAIN.home), 'the lock does not live in the data root');

    // two child processes, each with its OWN data root: the default lock path must be identical...
    const homeB = mkTmp('lockhome-b');
    const lockFile = path.join(MAIN.work, 'xproc-clipboard.lock');       // ...and (for the contention part) an explicit shared file keeps the real lock out of the test
    const script = `
      const clip = require(${JSON.stringify(path.join(REPO, 'src', 'clipboard.js'))});
      (async () => {
        const l = await clip.acquireLock({ file: process.env.LOCK_FILE, page: process.env.WHO, waitMs: 20000 });
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 900));
        const end = Date.now();
        await l.release();
        process.stdout.write(JSON.stringify({ who: process.env.WHO, home: process.env.NATIVEWRIGHT_HOME, lockPath: clip.lockPath(), start, end, waitedMs: l.waitedMs }));
      })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
    `;
    const run = (who, home) => new Promise((resolve, reject) => {
      const env = { ...process.env, NATIVEWRIGHT_HOME: home, NATIVEWRIGHT_USER_DATA_DIR: home, NATIVEWRIGHT_ARTIFACTS_DIR: home, LOCK_FILE: lockFile, WHO: who };
      const c = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '', se = '';
      c.stdout.on('data', (d) => { so += d; });
      c.stderr.on('data', (d) => { se += d; });
      c.on('exit', (code) => (code === 0 ? resolve(JSON.parse(so)) : reject(new Error(`child ${who} exit ${code}: ${se}`))));
    });
    try {
      const [ra, rb] = await Promise.all([run('A', MAIN.home), run('B', homeB)]);
      assert.notEqual(ra.home, rb.home, 'the two processes really have different NATIVEWRIGHT_HOME values');
      assert.equal(ra.lockPath, expected);
      assert.equal(rb.lockPath, expected, 'a different NATIVEWRIGHT_HOME must not change the lock file');
      const [first, second] = ra.start <= rb.start ? [ra, rb] : [rb, ra];
      assert.ok(first.end <= second.start, `the critical sections must not overlap (first ${first.start}-${first.end}, second ${second.start}-${second.end})`);
      assert.ok(second.waitedMs >= 500, `the second process waited for the first (${second.waitedMs} ms)`);
    } finally { fs.rmSync(homeB, { recursive: true, force: true }); }
  });

  it('Windows clipboard helper semantics on an in-memory stand-in (same PowerShell protocol; the human\'s clipboard is never touched)', { skip: WINDOWS_ONLY }, async () => {
    const b = require('../src/clipboard')._makeWindowsBackend({ fake: true });
    try {
      assert.deepEqual(await b.snapshot(), { kind: 'empty', formats: [], text: null });
      const uni = 'Привет\r\nмир ñ 😀 — "quotes" & <tags>';
      await b.seed(['UnicodeText', 'Text', 'OEMText', 'Locale'], uni);
      let s = await b.snapshot();
      assert.equal(s.kind, 'text');
      assert.equal(s.text, uni, 'Unicode, CRLF and emoji survive the base64 round trip');
      // anything but plain text is reported by format NAME only; its content is never handed over
      for (const extra of ['HTML Format', 'Rich Text Format', 'Bitmap', 'FileDrop', 'Chromium internal source URL']) {
        await b.seed(['UnicodeText', extra], 'looks like a secret');
        const o = await b.snapshot();
        assert.equal(o.kind, 'other', `${extra} makes it non-plain-text`);
        assert.equal(o.text, null, 'the text of a non-plain-text clipboard is not even read');
        assert.ok(o.formats.includes(extra));
      }
      // write -> restore puts the original text back; restore is conditional on our payload still being there
      await b.seed(['UnicodeText'], 'original text');
      const snap = await b.snapshot();
      await b.write('PAYLOAD');
      // the payload is flagged to stay out of clipboard history / cloud sync / clipboard monitors: UnicodeText plus the
      // three registered formats (the Windows names). A plain-text snapshot of it is therefore NOT "plain text only".
      const onClip = await b.peek();
      assert.equal(onClip.text, 'PAYLOAD');
      for (const f of ['UnicodeText', 'ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']) {
        assert.ok(onClip.formats.includes(f), `the payload carries ${f}: ${onClip.formats}`);
      }
      const payloadSnap = await b.snapshot();
      assert.equal(payloadSnap.kind, 'other', 'a clipboard that carries the flag formats is never classified as plain text');
      assert.equal(payloadSnap.text, null, 'and its text is not read');
      // restore recognises our payload WITH the flag formats and puts the human's text back as plain text only
      assert.deepEqual(await b.restoreIfOurs(snap, 'PAYLOAD'), { restored: true });
      const back = await b.peek();
      assert.equal(back.text, 'original text');
      assert.deepEqual(back.formats.filter((f) => !['UnicodeText', 'Text', 'OEMText', 'Locale'].includes(f)), [], 'the restored clipboard carries none of the flag formats');
      assert.equal((await b.snapshot()).text, 'original text');
      await b.write('PAYLOAD-2');
      await b.seed(['UnicodeText'], 'the human copied something else meanwhile');
      const r = await b.restoreIfOurs(snap, 'PAYLOAD-2');
      assert.equal(r.restored, false);
      assert.match(r.reason, /changed meanwhile/);
      assert.equal((await b.snapshot()).text, 'the human copied something else meanwhile', 'the newer clipboard is left alone');
      // the same text but on a human clipboard that is NOT our payload (not text-only: HTML) is left alone as well
      await b.seed(['UnicodeText', 'HTML Format'], 'PAYLOAD-2');
      assert.equal((await b.restoreIfOurs(snap, 'PAYLOAD-2')).restored, false, 'text + HTML is not our payload');
      assert.deepEqual((await b.peek()).formats, ['UnicodeText', 'HTML Format']);
      // an originally EMPTY clipboard is emptied again
      await b.seed([], null);
      const empty = await b.snapshot();
      await b.write('P3');
      assert.deepEqual(await b.restoreIfOurs(empty, 'P3'), { restored: true });
      assert.equal((await b.snapshot()).kind, 'empty');
      assert.deepEqual(await b.peek(), { formats: [], text: null });
      // large payloads (long --from-file text)
      const big = 'x'.repeat(2_500_000) + 'Ω';
      await b.write(big);
      assert.equal((await b.peek()).text, big);
      assert.deepEqual(await b.restoreIfOurs(empty, big), { restored: true });
    } finally { b.dispose(); }
  });

  it('a HUMAN clipboard that carries the payload flags (password managers set ExcludeClipboardContentFromMonitorProcessing) stays "other": its text is never read, and nothing restores over it', { skip: WINDOWS_ONLY }, async () => {
    const b = require('../src/clipboard')._makeWindowsBackend({ fake: true });
    try {
      for (const flag of ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']) {
        await b.seed(['UnicodeText', flag], 'hunter2');
        const s = await b.snapshot();
        assert.equal(s.kind, 'other', `${flag} makes a clipboard non-plain-text`);
        assert.equal(s.text, null, 'the text is not even read');
        assert.deepEqual(s.formats, ['UnicodeText', flag]);
      }
      // the restore is conditional on the clipboard holding OUR payload text: a manager's entry with other text is untouched
      const original = { kind: 'text', formats: ['UnicodeText'], text: 'my text' };
      await b.seed(['UnicodeText', 'ExcludeClipboardContentFromMonitorProcessing'], 'hunter2');
      const r = await b.restoreIfOurs(original, 'PAYLOAD');
      assert.equal(r.restored, false);
      assert.deepEqual(await b.peek(), { formats: ['UnicodeText', 'ExcludeClipboardContentFromMonitorProcessing'], text: 'hunter2' });
    } finally { b.dispose(); }
  });

  it('the helper process: answers after an idle pause and PUMPS window messages while idle (a WinForms timer ticks in an idle helper); a failing call is retried on a ~2 s budget', { skip: WINDOWS_ONLY }, async () => {
    const b = require('../src/clipboard')._makeWindowsBackend({ fake: true });
    try {
      await b.seed(['UnicodeText'], 'before the pause');
      await new Promise((r) => setTimeout(r, 1300));
      assert.equal((await b.snapshot()).text, 'before the pause', 'the protocol still works after more than a second without a request');
      // A WinForms Timer only fires if its thread dispatches messages. The old loop parked in a blocking stdin read
      // ([Console]::In.ReadLine()) would get 0 ticks here (measured); the pumping loop drains the queue every 200 ms (a few ticks
      // in a second: the timer is ticking every 40 ms but WM_TIMER is a posted message, one pending at a time).
      await b.pumpArm();
      await new Promise((r) => setTimeout(r, 1000));
      const hits = await b.pumpHits();
      assert.ok(hits >= 2, `the idle helper dispatched window messages (${hits} timer ticks in 1000 ms)`);
      // bounded retries: an operation that always fails stops being retried after about the budget (2 s)
      const took = await b.retryProbeMs();
      assert.ok(took >= 1900 && took < 6000, `Retry gave up after ${took} ms`);
    } finally { b.dispose(); }
  });

  it('unanswered-request accounting + kill: a timed-out request stays counted until its late reply or the kill; kill is immediate; the next request starts a fresh helper', { skip: WINDOWS_ONLY }, async () => {
    const b = require('../src/clipboard')._makeWindowsBackend({ fake: true });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      assert.equal(b.hasUnanswered(), false, 'nothing asked yet');
      await b.seed(['UnicodeText'], 'state of the first helper');
      assert.equal(b.hasUnanswered(), false, 'answered requests are not counted');
      const first = b.pid();
      assert.ok(alive(first));

      // a request that is answered LATE: counted from the moment it is written until its reply arrives, also after the caller gave up
      await assert.rejects(() => b.stall(1000, { timeoutMs: 150 }), (e) => /timed out \(stall\)/.test(e.message) && e.uncertain === true);
      assert.equal(b.hasUnanswered(), true, 'the helper still owes the answer');
      await new Promise((r) => setTimeout(r, 1800));
      assert.equal(b.hasUnanswered(), false, 'the late reply settled it');

      // a request that is never answered in time: kill it
      await assert.rejects(() => b.stall(20_000, { timeoutMs: 150 }), (e) => /timed out/.test(e.message));
      assert.equal(b.hasUnanswered(), true);
      const t0 = Date.now();
      await b.kill();
      assert.ok(Date.now() - t0 < 2500, `kill returns promptly (${Date.now() - t0} ms)`);
      assert.equal(b.hasUnanswered(), false, 'a killed helper owes nothing');
      assert.equal(alive(first), false, 'the helper process is gone when kill() returns (nothing it was asked can happen later)');

      // the next request transparently starts a fresh helper (its in-memory clipboard starts empty)
      assert.deepEqual(await b.snapshot(), { kind: 'empty', formats: [], text: null });
      assert.notEqual(b.pid(), first);
      assert.ok(alive(b.pid()));
      assert.equal(b.hasUnanswered(), false);
      await b.kill();
      await b.kill();                                          // killing a helper that is not running is a no-op
      assert.equal(b.hasUnanswered(), false);
    } finally { b.dispose(); }
  });

  it('the helper start is bounded: a helper that is not ready in time is killed and reported; a later warm works; the script fits the command line', { skip: WINDOWS_ONLY }, async () => {
    const clipMod = require('../src/clipboard');
    for (const fake of [true, false]) {
      const encoded = Buffer.from(clipMod._workerScript(fake), 'utf16le').toString('base64').length;
      assert.ok(encoded < 28_000, `the ${fake ? 'in-memory' : 'real'} helper script is passed as -EncodedCommand and must stay far below the 32767-char command line limit (${encoded})`);
    }
    const b = clipMod._makeWindowsBackend({ fake: true });
    try {
      await assert.rejects(() => b.warm({ timeoutMs: 1 }), /did not start within 1 ms/);
      assert.equal(b.hasUnanswered(), false);
      await b.warm({ timeoutMs: 30_000 });
      assert.deepEqual(await b.snapshot(), { kind: 'empty', formats: [], text: null });
    } finally { b.dispose(); }
  });

  it('the helper is released after its idle time, and warm() starts that time over (a helper warmed just before the lock cannot be released while the paste waits for the lock)', { skip: WINDOWS_ONLY }, async () => {
    const b = require('../src/clipboard')._makeWindowsBackend({ fake: true, idleMs: 2000 });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await b.warm();
      const pid = b.pid();
      await sleep(1200);
      await b.warm();                       // the idle time starts over: without that the helper would go at ~2000 ms
      await sleep(1300);                    // 2500 ms after the first warm()
      assert.equal(alive(pid), true, 'still running: the second warm() started the idle time over');
      assert.equal(b.pid(), pid);
      await sleep(1700);                    // 2900 ms after the second warm()
      assert.equal(alive(pid), false, 'released after its idle time');
      assert.equal(b.pid(), null);
      assert.deepEqual(await b.snapshot(), { kind: 'empty', formats: [], text: null }, 'the next request starts a new helper');
      assert.notEqual(b.pid(), pid);
    } finally { b.dispose(); }
  });

  // ---- the paste flow itself, around a REAL helper process holding the in-memory clipboard (the OS clipboard is never
  // touched; the lock is a private file, so a daemon's real one is never taken) ----

  // A page the flow can run against: no DOM (the focused-field probes find nothing), key events are recorded, and the
  // paste probe reports a paste event, so a Ctrl+V counts as having worked.
  function flowPage(onVKey) {
    const events = [];
    const cdp = {
      async send(method, params) {
        events.push({ m: method, ...params });
        if (onVKey && method === 'Input.dispatchKeyEvent' && params.type !== 'keyUp' && /^v$/i.test(params.key || '')) await onVKey();
      },
    };
    return {
      events,
      async evaluate() { return { inputFromPaste: true, paste: { trusted: true, types: ['text/plain'] } }; },
      mainFrame: () => ({ evaluateHandle: async () => { throw new Error('no dom in this mock'); } }),
      context() { return { newCDPSession: async () => cdp }; },
      keyboard: {
        async down(k) { events.push({ pw: 'down', key: k }); }, async up(k) { events.push({ pw: 'up', key: k }); },
        async press(k) { events.push({ pw: 'press', key: k }); }, async insertText(text) { events.push({ pw: 'insertText', text }); },
      },
      mouse: { async move() {}, async down() {}, async up() {}, async wheel() {} },
      viewportSize() { return null; },
    };
  }

  async function pasteThroughHelper(backend, text, { page = flowPage(), onLock, onRelease, paste = {} } = {}) {
    const cb = require('../src/clipboard');
    const human = require('../src/human');
    const saved = { detect: cb.detectBackend, lock: cb.acquireLock };
    const lockFile = path.join(MAIN.work, `paste-flow-${process.hrtime.bigint()}.lock`);
    cb.detectBackend = async () => ({ backend });
    cb.acquireLock = async (opts) => {
      if (onLock) onLock();
      const l = await saved.lock({ ...opts, file: lockFile });
      return { waitedMs: l.waitedMs, release: async () => { if (onRelease) onRelease(); await l.release(); } };
    };
    try {
      const r = await require('../src/paste').pasteFocused({ page, rec: { id: 'p-flow' }, session: { isHeadless: () => false } }, text,
        { rng: human.makeRng(7), typos: 'off', ...paste });
      return { r, lockFile };
    } finally { cb.detectBackend = saved.detect; cb.acquireLock = saved.lock; }
  }
  const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('paste flow: the payload carries the flag formats while Ctrl+V happens, the human\'s text comes back as plain text, and a healthy helper is left running', { skip: WINDOWS_ONLY }, async () => {
    const backend = require('../src/clipboard')._makeWindowsBackend({ fake: true });
    try {
      await backend.warm();
      await backend.seed(['UnicodeText', 'Text', 'OEMText', 'Locale'], 'the human text');
      const pid = backend.pid();
      let atCtrlV = null;
      const { r, lockFile } = await pasteThroughHelper(backend, 'PAYLOAD for the field', { page: flowPage(async () => { atCtrlV = await backend.peek(); }) });
      assert.equal(r.method, 'paste');
      assert.equal(r.clipboardTouched, true);
      assert.equal(r.clipboardRestored, true);
      assert.ok(atCtrlV, 'the V key was pressed');
      assert.equal(atCtrlV.text, 'PAYLOAD for the field', 'the payload was on the clipboard at Ctrl+V');
      for (const f of ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']) assert.ok(atCtrlV.formats.includes(f), `${f} was set during the paste`);
      const after = await backend.peek();
      assert.equal(after.text, 'the human text');
      assert.deepEqual(after.formats, ['UnicodeText', 'Text', 'OEMText', 'Locale'], 'the human\'s clipboard is back with exactly the plain-text formats');
      assert.equal(backend.pid(), pid, 'the same, healthy helper served the whole paste (no needless kill)');
      assert.equal(backend.hasUnanswered(), false);
      assert.equal(fs.existsSync(lockFile), false, 'the lock was released');
      assert.equal(JSON.stringify(r).includes('the human text'), false, 'clipboard contents are never returned');
    } finally { backend.dispose(); }
  });

  it('paste flow, a write that hangs: the helper is killed BEFORE the lock is released (a request still pending in it cannot run later), the restore goes through a fresh helper, and the report is honest', { skip: WINDOWS_ONLY }, async () => {
    const backend = require('../src/clipboard')._makeWindowsBackend({ fake: true });
    try {
      await backend.warm();
      await backend.seed(['UnicodeText', 'Text', 'OEMText', 'Locale'], 'the human text');
      const hung = backend.pid();
      await backend.hangNextWrite(30_000);               // the next write blocks inside the helper far longer than the in-lock timeout
      let aliveAtRelease = null;
      const { r, lockFile } = await pasteThroughHelper(backend, 'typed instead', {
        paste: { inLockTimeoutMs: 3000 },
        onRelease: () => { aliveAtRelease = alivePid(hung); },
      });
      assert.equal(aliveAtRelease, false, 'the helper that still owed the write was dead before the lock was released');
      assert.equal(r.method, 'typed');
      assert.equal(r.reason, 'clipboard-unwritable');
      assert.match(r.detail, /timed out \(write\)/);
      assert.equal(r.clipboardRestored, false, 'the clipboard could not be confirmed unchanged, so it is not claimed as restored');
      assert.match(r.restoreNote, /helper was stopped/);
      assert.equal(backend.hasUnanswered(), false);
      assert.notEqual(backend.pid(), hung, 'the restore was attempted through a fresh helper');
      assert.equal(fs.existsSync(lockFile), false, 'the lock was released');
      assert.equal(JSON.stringify(r).includes('the human text'), false, 'clipboard contents are never returned');
    } finally { backend.dispose(); }
  });

  it('paste flow, a helper that cannot be started in time: typed with clipboard-unreadable and a clear detail, and the lock is never taken', { skip: WINDOWS_ONLY }, async () => {
    const backend = require('../src/clipboard')._makeWindowsBackend({ fake: true });
    try {
      let lockAsked = 0;
      const { r } = await pasteThroughHelper(backend, 'typed instead', { paste: { warmTimeoutMs: 1 }, onLock: () => { lockAsked++; } });
      assert.equal(r.method, 'typed');
      assert.equal(r.reason, 'clipboard-unreadable');
      assert.match(r.detail, /clipboard helper could not be started: .*did not start within 1 ms/);
      assert.equal(r.clipboardTouched, false);
      assert.equal(r.clipboardRestored, true);
      assert.equal(lockAsked, 0, 'no lock is held for a helper that is not running');
    } finally { backend.dispose(); }
  });

  it('paste into a field: a real Ctrl+V paste when the OS clipboard is safe to use, else typed fallback; the user\'s clipboard is never destroyed', async (t) => {
    S.reset('keys');
    const before = await clipState();
    const payload = 'PASTE-TEST ñ Привет — line one\nline two';
    const r = S.ok(['paste', '#ta', payload], { timeout: 240_000 });
    assert.equal(r.chars, [...payload].length);
    assert.ok('lockWaitMs' in r && 'clipboardRestored' in r && 'verified' in r);
    const value = S.eval('document.getElementById("ta").value');
    assert.ok(value.replace(/\s+/g, ' ').includes(payload.replace(/\s+/g, ' ')), 'the text arrived in the field');
    const after = await clipState();
    if (HEADLESS) {
      t.diagnostic('headless: documented fallback asserted');
      assert.equal(r.method, 'typed');
      assert.equal(r.reason, 'headless');
      assert.equal(r.clipboardTouched, false);
    } else if (before.kind === 'text' || before.kind === 'empty') {
      t.diagnostic(`headed, clipboard was ${before.kind}: real paste asserted`);
      assert.equal(r.method, 'paste');
      assert.equal(r.verified, true);
      assert.equal(r.clipboardTouched, true);
      assert.equal(r.clipboardRestored, true, 'the clipboard was restored');
      assert.equal(after.kind, before.kind);
      assert.equal(after.text ?? null, before.text ?? null, 'the human\'s clipboard text is exactly what it was');
      const ev = S.log();
      const paste = ev.find((e) => e[0] === 'paste');
      assert.ok(paste && paste[2] === true, 'a trusted paste event');
      assert.ok(paste[3].includes('text/plain'), 'with clipboardData');
      assert.ok(ev.some((e) => e[0] === 'bi' && e[2] === 'insertFromPaste' && e[3] === true), 'beforeinput insertFromPaste');
      assert.ok(keyLog(ev).some((e) => e[3] === 'ControlLeft') && keyLog(ev).some((e) => e[3] === 'KeyV'), 'a human Ctrl+V');
    } else {
      t.diagnostic(`headed, clipboard holds ${JSON.stringify(before.formats)}: the clipboard must be left untouched`);
      assert.equal(r.method, 'typed');
      assert.match(r.reason, /non-text|no-clipboard-tool|unreadable/);
      assert.equal(r.clipboardTouched, false);
      assert.deepEqual(after.formats, before.formats, 'non-text clipboard left exactly as it was');
    }
    assert.equal(JSON.stringify(r).includes('Привет'), false, 'clipboard contents are never returned');
  });

  it('paste-focused and --from-file (long text, path relative to the caller\'s cwd); text and file are exclusive', () => {
    S.reset('keys');
    S.ok(['click', '#in']);
    const r = S.ok(['paste-focused', 'focused paste'], { timeout: 240_000 });
    assert.ok(['paste', 'typed'].includes(r.method));
    assert.equal(S.eval('document.getElementById("in").value'), 'focused paste');
    const fileText = 'file text '.repeat(8).trim();                        // 79 characters: enough to prove --from-file, quick to type headless
    fs.writeFileSync(path.join(MAIN.work, 'long.txt'), fileText);
    S.eval('document.getElementById("ta").value = "", 1');
    const f = S.ok(['paste', '#ta', '--from-file=long.txt'], { timeout: 300_000 });
    assert.equal(f.chars, fileText.length);
    assert.equal(S.eval('document.getElementById("ta").value'), fileText);
    assert.match(S.bad(['paste', '#ta', 'x', '--from-file=long.txt']).error, /not both/);
    assert.match(S.bad(['paste', '#ta', '--from-file=missing.txt']).error, /file not found/);
    assert.match(S.bad(['paste-focused']).error, /text required/);
  });

  it('a paste that falls back to typing refuses a text longer than 2000 characters instead of typing it for minutes (headless: nothing is typed)', (t) => {
    if (!HEADLESS) return t.skip('headed: with an empty or plain-text clipboard this would be a real paste, nothing to refuse; the guard is covered headless here and in human.sanity.js');
    S.reset('keys');
    S.ok(['click', '#ta']);
    const long = 'x'.repeat(2001);
    const e = S.bad(['paste-focused', long], { timeout: 120_000 }).error;
    assert.match(e, /reason 'headless'/, 'the error names the fallback reason');
    assert.match(e, /2001 characters/);
    assert.match(e, /about \d+ minutes?/, 'and what typing it like a human would take');
    assert.match(e, /headed daemon/);
    assert.match(e, /plain-text clipboard/);
    assert.match(e, /fill --raw/, 'and the way out for bulk text');
    assert.equal(S.eval('document.getElementById("ta").value'), '', 'nothing was typed');
    fs.writeFileSync(path.join(MAIN.work, 'long2001.txt'), long);
    assert.match(S.bad(['paste', '#ta', '--from-file=long2001.txt'], { timeout: 120_000 }).error, /2001 characters/, 'a file is held to the same limit');
    S.expectNothingHeld();
    assert.equal(require('../src/paste').MAX_TYPED_FALLBACK_CHARS, 2000, 'the limit is 2000 characters');
  });

  it('the typing fallback honours --typos', () => {
    S.reset('keys');
    S.ok(['click', '#pw']);
    const r = S.ok(['paste-focused', 'secret', '--typos=off', '--raw=false'], { timeout: 240_000 });
    assert.ok(['paste', 'typed'].includes(r.method));
    assert.match(S.bad(['paste-focused', 'x', '--typos=maybe']).error, /bad --typos/);
  });

  after(() => { try { require('../src/clipboard').dispose(); } catch { /* ignore */ } });
});

// ===========================================================================
// F1: one OS clipboard, many daemons (different NATIVEWRIGHT_HOME)
// ===========================================================================

describe('F1: two daemons with DIFFERENT NATIVEWRIGHT_HOME paste concurrently into the one OS clipboard',
  { skip: HEADLESS && 'headless Chrome pastes into its own in-process clipboard (typed here), so the OS-clipboard lock is not exercised; run headed' }, () => {
    let S2;
    before(async () => {
      await startDaemon(SECOND);
      S2 = new Session(SECOND);
      S2.newPage('second-daemon');
      // warm both PowerShell helpers up (the first start costs seconds) so the contention below is about the lock, not about start-up
      S.reset('keys'); S2.go('keys');
      S.ok(['paste', '#in', 'warm-up'], { timeout: 240_000 });
      S2.ok(['paste', '#in', 'warm-up'], { timeout: 240_000 });
    });

    it('each field gets its own payload, both wait on the SAME lock, and the human\'s clipboard ends exactly as it was', async (t) => {
      const clip = require('../src/clipboard');
      assert.notEqual(MAIN.home, SECOND.home, 'two distinct data roots');
      S.reset('keys'); S2.go('keys');
      const before = await clipState();
      const payloadA = 'ALPHA ' + 'a1 ñ Привет '.repeat(3).trim();
      const payloadB = 'BRAVO ' + 'b2 ü мир '.repeat(3).trim();

      // Focus both fields first (so the concurrent command is the paste itself, not a human mouse move that would delay its
      // lock attempt), then hold the machine-wide lock while BOTH daemons are asked to paste: a daemon that used a lock
      // under its own NATIVEWRIGHT_HOME would not notice it and would finish at once.
      S.ok(['click', '#ta']); S2.ok(['click', '#ta']);
      const gate = await clip.acquireLock({ page: 'test-gate' });
      let finished = 0;
      const pa = cliAsync(MAIN, ['paste-focused', payloadA, `--page=${S.page}`]).then((r) => { finished++; return r; });
      const pb = cliAsync(SECOND, ['paste-focused', payloadB, `--page=${S2.page}`]).then((r) => { finished++; return r; });
      await new Promise((r) => setTimeout(r, 3000));
      const finishedWhileLocked = finished;
      await gate.release();
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.equal(finishedWhileLocked, 0, 'neither daemon pasted while another process held the machine-wide lock');
      assert.equal(ra.body && ra.body.ok, true, ra.raw);
      assert.equal(rb.body && rb.body.ok, true, rb.raw);
      const a = ra.body.result, b = rb.body.result;
      assert.ok(a.lockWaitMs >= 1800, `daemon A waited for the lock (${a.lockWaitMs} ms)`);
      assert.ok(b.lockWaitMs >= 1800, `daemon B waited for the lock (${b.lockWaitMs} ms)`);

      const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
      const va = norm(S.eval('document.getElementById("ta").value'));
      const vb = norm(S2.eval('document.getElementById("ta").value'));
      assert.ok(va.includes(norm(payloadA)), `A's field holds A's payload: ${va}`);
      assert.ok(vb.includes(norm(payloadB)), `B's field holds B's payload: ${vb}`);
      assert.ok(!va.includes('BRAVO') && !vb.includes('ALPHA'), 'no cross-talk between the two pastes');

      const after = await clipState();
      t.diagnostic(`OS clipboard was ${before.kind}; methods: A ${a.method}${a.reason ? ' (' + a.reason + ')' : ''}, B ${b.method}${b.reason ? ' (' + b.reason + ')' : ''}; waits A ${a.lockWaitMs} ms, B ${b.lockWaitMs} ms`);
      assert.equal(after.kind, before.kind, 'the clipboard is the same kind of thing afterwards');
      assert.equal(after.text ?? null, before.text ?? null, 'text (or emptiness) restored exactly');
      if (before.kind === 'other') assert.deepEqual(after.formats, before.formats, 'a non-text clipboard is never touched');
      if (a.method === 'paste' && b.method === 'paste') {
        assert.equal(a.clipboardRestored && b.clipboardRestored, true, 'both pastes restored the clipboard');
        // serialised: the loser also waited for the winner's whole paste (a paste takes well over 300 ms)
        assert.ok(Math.abs(a.lockWaitMs - b.lockWaitMs) >= 300, `one paste ran after the other (waits ${a.lockWaitMs} / ${b.lockWaitMs} ms)`);
      } else {
        // a non-text (or unreadable) clipboard is never touched: BOTH fell back to typing, each for that documented reason
        for (const r of [a, b]) {
          assert.equal(r.method, 'typed', `unexpected mixed outcome: ${JSON.stringify([a, b])}`);
          assert.match(r.reason, /non-text|no-clipboard-tool|unreadable/);
        }
      }
      assert.equal(JSON.stringify([a, b]).includes('Привет'), false, 'clipboard contents are never returned');
    });

    after(() => { try { S2.ok(['close']); } catch { /* the global after() stops the daemon */ } });
  });

// ===========================================================================
// wheel calibration
// ===========================================================================

describe('calibrate-wheel', () => {
  const calFile = path.join(MAIN.home, 'wheel-calibration.json');

  it('records trusted wheel events (fed through CDP by --simulate) into <BASE_HOME>/wheel-calibration.json; a SIMULATED profile is saved but never adopted (W1)', () => {
    S.reset('scroll');
    fs.rmSync(calFile, { force: true });
    assert.equal(S.ok(['state']).wheelModel, 'default', 'no calibration file: the default model is active');
    assert.equal(S.ok(['state']).wheelCalibration, null);
    const r = S.ok(['calibrate-wheel', '--seconds=6', '--simulate=true'], { timeout: 120_000 });
    assert.equal(r.saved, calFile, 'written to <BASE_HOME>/wheel-calibration.json');
    assert.ok(r.events >= 20, `${r.events} events`);
    assert.equal(r.source, 'simulated');
    assert.equal(r.quantum, 100);
    assert.equal(r.ignoredUntrusted, 0);
    assert.equal(r.activeModel, 'default', 'the response says which model scrolling uses: a simulated profile is not adopted');
    assert.match(r.note, /NOT used for scrolling/);
    const p = JSON.parse(fs.readFileSync(calFile, 'utf8'));
    assert.equal(p.version, 1);
    assert.equal(p.deltaMode, 0);
    assert.equal(p.source, 'simulated');
    assert.ok(p.intraGap.median > 0 && p.interGap.median > 0 && p.burstLen.length > 0);
    assert.equal(S.evalJson('document.getElementById("__nw_wheel_overlay")'), null, 'the overlay is removed afterwards');
    S.clearLog();
    const sc = S.ok(['scroll', '800', '--target=#panel']);
    assert.equal(sc.wheelModel, 'default', 'scrolling keeps the DEFAULT model: our own synthetic events are never learned from');
    near(sc.scrolledBy, 800, 100);
    const st = S.ok(['state']);
    assert.equal(st.wheelModel, 'default');
    assert.equal(st.wheelCalibration.source, 'simulated');
    assert.equal(st.wheelCalibration.adopted, false);
    assert.equal(st.wheelCalibration.file, calFile);
    assert.equal(cli(MAIN, ['status']).body.wheelModel, 'default', '`status` reports the active model too');
  });

  it('a human calibration IS adopted by scrolling, and `state` / `status` / `scroll` say so', () => {
    S.reset('scroll');
    const p = JSON.parse(fs.readFileSync(calFile, 'utf8'));
    p.source = 'human';                                         // what the interactive (non --simulate) calibration records
    fs.writeFileSync(calFile, JSON.stringify(p));
    const sc = S.ok(['scroll', '800', '--target=#panel']);
    assert.equal(sc.wheelModel, 'human', 'a human calibration is adopted');
    near(sc.scrolledBy, 800, 100);
    const st = S.ok(['state']);
    assert.equal(st.wheelModel, 'human');
    assert.equal(st.wheelCalibration.adopted, true);
    assert.equal(cli(MAIN, ['status']).body.wheelModel, 'human');
    // any other source, and a corrupt file, fall back to the default instead of breaking scrolling
    p.source = 'something-else'; fs.writeFileSync(calFile, JSON.stringify(p));
    S.reset('scroll');
    assert.equal(S.ok(['scroll', '200', '--target=#panel']).wheelModel, 'default');
    fs.writeFileSync(calFile, '{ not json');
    assert.equal(S.ok(['scroll', '200', '--target=#panel']).wheelModel, 'default');
    assert.equal(S.ok(['state']).wheelCalibration, null);
    p.source = 'simulated'; fs.writeFileSync(calFile, JSON.stringify(p));   // leave what the next test expects
  });

  it('a calibration with too few events is rejected clearly and writes nothing; a human calibration is not clobbered by a simulated one', () => {
    S.reset('scroll');
    const keep = fs.readFileSync(calFile, 'utf8');
    const e = S.bad(['calibrate-wheel', '--seconds=2']);
    assert.match(e.error, /only 0 usable wheel event/);
    assert.match(e.error, /at least 20/);
    assert.equal(fs.readFileSync(calFile, 'utf8'), keep, 'the existing calibration is unchanged');
    const p = JSON.parse(keep); p.source = 'human'; fs.writeFileSync(calFile, JSON.stringify(p));
    assert.match(S.bad(['calibrate-wheel', '--seconds=2', '--simulate=true']).error, /refusing to overwrite a HUMAN/);
    assert.match(S.bad(['calibrate-wheel', '--seconds=0']).error, /bad --seconds/);
    fs.rmSync(calFile, { force: true });       // back to the default model for any later test
    S.reset();
    S.go('scroll');
    assert.equal(S.ok(['scroll', '200', '--target=#panel']).wheelModel, 'default');
  });

  it('is refused on a page that is neither blank nor local - its overlay is visible to the site\'s own scripts - before anything is injected; a new page starts on about:blank, where it is allowed', (t) => {
    if (!ORIGIN_C) return t.skip('127.0.0.2 cannot be bound here (macOS has only 127.0.0.1 on lo0): there is no "website" to point the page at');
    const created = cli(MAIN, ['new', '--label=calibrate-guard']);
    assert.equal(created.body && created.body.ok, true, created.raw);
    assert.equal(created.body.result.url, 'about:blank', 'a new page starts on about:blank: the place to calibrate');
    const P = new Session(MAIN);
    P.page = created.body.result.page;
    try {
      fs.rmSync(calFile, { force: true });
      // blank: accepted (this run then fails for lack of wheel events, which is not the guard)
      assert.match(P.bad(['calibrate-wheel', '--seconds=1']).error, /only 0 usable wheel event/);
      // a page that is neither blank nor local: refused up front, with the reason and the way out
      P.ok(['goto', `${ORIGIN_C}/scroll.html`, '--raw=true']);
      for (const extra of [[], ['--simulate=true']]) {
        const e = P.bad(['calibrate-wheel', '--seconds=1', ...extra]).error;
        assert.match(e, /refused/);
        assert.match(e, /about:blank/, 'the way out is named: a blank page');
        assert.match(e, /nativewright new --label=calibrate/);
        assert.match(e, /overlay/);
        assert.match(e, /site's own scripts/, 'and the reason: the overlay is visible to the site');
        assert.match(e, /localhost \/ 127\.0\.0\.1 \/ \[::1\]/, 'and what is allowed');
      }
      assert.equal(P.evalJson('document.getElementById("__nw_wheel_overlay")'), null, 'no overlay element was put into the page');
      assert.equal(P.eval('typeof window.__nw_wheel'), 'undefined', 'and no recorder');
      assert.equal(fs.existsSync(calFile), false, 'nothing was saved');
    } finally { try { P.ok(['close']); } catch { /* the global after() stops the daemon */ } }
  });
});

// ===========================================================================
// file drag-and-drop
// ===========================================================================

describe('drop-files: OS files dragged in from the window edge', () => {
  it('delivers real File objects (names, sizes, MIME, content) with trusted events, entering from the nearest edge', () => {
    S.reset('drop');
    fs.writeFileSync(path.join(MAIN.work, 'hello world.txt'), 'hello drop\nline2');
    fs.writeFileSync(path.join(MAIN.work, 'данные.csv'), 'a,b\n1,2\n');
    const zone = S.rect('#zone');
    const r = S.ok(['drop-files', '#zone', 'hello world.txt', 'данные.csv']);
    assert.deepEqual(r.files.map((f) => [f.name, f.size]), [['hello world.txt', 16], ['данные.csv', 8]]);
    const log = S.log();
    const enter = log.find((e) => e[0] === 'dragenter');
    assert.ok(enter && enter[1] === true && /Files/.test(enter[2]), 'trusted dragenter with Files');
    const drop = log.find((e) => e[0] === 'drop');
    assert.equal(drop[1], true, 'trusted drop');
    assert.ok(drop[2] > 3, `dragover while travelling (${drop[2]})`);
    // A file manager's drag offers copy | link | move, which a page sees as effectAllowed 'all'. (Measured: the old mask, copy only, gave
    // 'copy', and a page that answers with dropEffect 'move' - the fixture does - then gets no drop at all.)
    assert.equal(enter[3], 'all', 'dragenter: effectAllowed is "all"');
    assert.equal(drop[4], 'all', 'drop: effectAllowed is "all"');
    assert.equal(drop[5], 'move', "and the page's dropEffect 'move' was honoured");
    assert.deepEqual(drop[3].map((f) => [f.name, f.size, f.text]), [['hello world.txt', 16, 'hello drop\nline2'], ['данные.csv', 8, 'a,b\n1,2\n']]);
    assert.equal(drop[3][1].type, 'text/csv');
    // the drag entered from a window edge (within a few px of it)
    const m = S.metrics();
    const e = r.entry;
    const nearEdge = Math.min(e.x, m.w - e.x, e.y, m.h - e.y);
    assert.ok(nearEdge <= 5, `entered ${nearEdge}px from the nearest window edge`);
    assert.ok(r.landedAt.x >= zone.x && r.landedAt.x <= zone.x + zone.width && r.landedAt.y >= zone.y && r.landedAt.y <= zone.y + zone.height, 'dropped inside the zone');
    near(S.pointer().x, r.landedAt.x, 0.2, 'the pointer state follows the drop');
  });

  it('dropping onto an <input type=file> sets its files; --at picks the point; bad paths are errors', () => {
    S.reset('drop');
    fs.writeFileSync(path.join(MAIN.work, 'a.txt'), 'A');
    S.ok(['drop-files', '#fi', 'a.txt']);
    const ch = S.log().find((e) => e[0] === 'fi-change');
    assert.deepEqual(ch[1], ['a.txt']);
    S.clearLog();
    const zone = S.rect('#zone');
    const r = S.ok(['drop-files', '#zone', 'a.txt', '--at=10,10', '--exact=true']);
    near(r.landedAt.x, zone.x + 10, 0.2); near(r.landedAt.y, zone.y + 10, 0.2);
    assert.match(S.bad(['drop-files', '#zone', 'nope.bin']).error, /file not found/);
    assert.match(S.bad(['drop-files', '#zone', '.']).error, /not a file/);
    assert.match(S.bad(['drop-files', '#zone']).error, /at least one file/);
    const raw = S.ok(['drop-files', '#zone', 'a.txt', '--raw=true']);
    assert.ok(raw.durationMs < 1500);
    assert.ok(S.log().some((e) => e[0] === 'drop' && e[3][0].text === 'A'));
  });
});

// ===========================================================================
// input fidelity: what a page can MEASURE about the input
// ===========================================================================

describe('input fidelity: pointer coordinates on the device-pixel grid, dwell and gaps in real time, discrete events stamped at dispatch', () => {
  // The fixture's listeners (fidelity.html) run in the page's MAIN world, like a site's own. A "lattice share" is the share of values
  // within +-1 ms of a multiple of 15.625 ms, the Windows timer tick: ~0.9-1.0 for waits that ride the OS timer (measured), ~0.13 for
  // continuous ones. On Linux and macOS Node's timers are ~1 ms precise, so these checks pass there trivially.
  const TICK = 15.625;
  const latticeShare = (vals) => vals.filter((v) => { const r = ((v % TICK) + TICK) % TICK; return Math.min(r, TICK - r) <= 1; }).length / vals.length;
  const onGrid = (v, dpr) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-3;
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const pointerLog = (log) => log.filter((e) => e[0] === 'pe');          // ['pe', type, clientX, clientY, timeStamp, lag, [[x, y, t]...], pointerType, buttons]

  it('every pointer coordinate the page sees - pointermove, pointerdown, pointerup and each coalesced sub-sample - is on the device-pixel grid (integers at dpr 1)', () => {
    S.reset('fidelity');
    const dpr = S.metrics().dpr;
    S.ok(['click', '#btn']);                                              // the human click on an element
    S.ok(['hover-at', '333.37', '222.21']);                               // a fractional request + the hand's jitter
    const exact = S.ok(['click-at', '640.6', '150.3', '--exact=true']);   // --exact skips only the jitter, not the grid
    S.ok(['drag-at', '420.4', '200.6', '600.3', '330.7']);                // a pointer-mode drag over empty page
    S.ok(['drag-at', '440.2', '400.4', '610.9', '420.2', '--raw=true']);   // the raw coordinate commands are snapped as well
    S.ok(['click-at', '555.55', '444.44', '--raw=true']);
    S.ok(['hover-at', '700.7', '70.7', '--raw=true']);
    const pe = pointerLog(S.log());
    const coordsSeen = [];
    let coalescedMoves = 0;
    for (const e of pe) {
      coordsSeen.push([e[2], e[3]]);
      if (e[6].length > 1) coalescedMoves += 1;
      for (const s of e[6]) coordsSeen.push([s[0], s[1]]);
    }
    assert.ok(pe.length > 40 && coalescedMoves > 5, `a real run was observed (${pe.length} pointer events, ${coalescedMoves} with several coalesced sub-samples)`);
    const off = coordsSeen.filter(([x, y]) => !onGrid(x, dpr) || !onGrid(y, dpr));
    assert.equal(off.length, 0, `${off.length} of ${coordsSeen.length} pointer coordinates are off the device-pixel grid at dpr ${dpr}: ${JSON.stringify(off.slice(0, 6))}`);
    // the reported landing point is the one that was dispatched
    assert.equal(+exact.landedAt.x.toFixed(3), +(Math.round(640.6 * dpr) / dpr).toFixed(3));
    assert.equal(+exact.landedAt.y.toFixed(3), +(Math.round(150.3 * dpr) / dpr).toFixed(3));
    const down = pe.filter((e) => e[1] === 'pointerdown').find((e) => Math.abs(e[2] - exact.landedAt.x) < 1e-3 && Math.abs(e[3] - exact.landedAt.y) < 1e-3);
    assert.ok(down, 'the pointerdown of click-at --exact sits exactly on the reported landing point');
    near(S.pointer().x, 700.7, 0.5 / dpr + 0.1, 'the tracked pointer is the snapped point of the last (raw) hover');
  });

  it('click dwell (pointerdown -> pointerup) is continuous: not a multiple of the 15.625 ms timer tick', () => {
    S.reset('fidelity');
    // 45 dwells. A CONTINUOUS dwell is within 1 ms of the lattice 17-19% of the time (measured, 300 dwells, both environments), so the
    // chance that a correct implementation scores 0.5 or more is ~1 in 115 with 14 dwells, ~1 in 8000 with 30 and ~1 in 700 000 with 45
    // (exact binomial tails at p = 0.19); lattice-bound dwells score ~0.9-1.0 and are caught with certainty at any of these sizes.
    for (let i = 0; i < 15; i++) S.ok(['click-at', String(450 + (i % 5) * 37), String(300 + (i % 5) * 11), '--clickCount=3', '--exact=true']);
    const pe = pointerLog(S.log());
    const downs = pe.filter((e) => e[1] === 'pointerdown'), ups = pe.filter((e) => e[1] === 'pointerup');
    assert.equal(downs.length, 45, 'forty-five clicks');
    assert.equal(ups.length, 45);
    const dwell = downs.map((d, i) => ups[i][4] - d[4]);
    assert.ok(dwell.every((d) => d > 15 && d < 300), `dwells are human-sized: ${dwell.map((d) => d.toFixed(1)).join(' ')}`);
    const share = latticeShare(dwell);
    assert.ok(share < 0.5, `lattice share of the click dwells ${share.toFixed(2)} (>= 0.9 means the dwell rides the OS timer tick): ${dwell.map((d) => d.toFixed(1)).join(' ')}`);
  });

  it('typing: key events are stamped at dispatch (none from the future, a small lag) and the gaps between keys are continuous', () => {
    S.reset('fidelity');
    S.ok(['click', '#txt']);
    S.clearLog();
    const text = 'the quick brown fox jumps over the lazy dog 0123';
    S.ok(['type-focused', text, '--typos=off']);
    assert.equal(S.eval('document.getElementById("txt").value'), text);
    const ks = S.log().filter((e) => e[0] === 'k');                      // ['k', type, key, code, timeStamp, lag, repeat, trusted]
    assert.ok(ks.length >= 2 * text.length, `${ks.length} key events`);
    assert.ok(ks.every((e) => e[7] === true), 'trusted');
    const lag = ks.map((e) => e[5]);
    // structural, never relaxed: an event is never dated in the future (a key-up stamped "down + dwell" was, and arrived up to 16 ms late)
    assert.ok(Math.min(...lag) >= -0.5, `no key event is dated in the future (smallest lag ${Math.min(...lag).toFixed(2)} ms)`);
    // absolute latency: Chrome stamps a discrete event when it receives it (~0.2 ms before the handler on a quiet machine)
    const med = median(lag), over8 = lag.filter((l) => l > 8).length / lag.length;
    assert.ok(med <= (CI ? 10 : 3), `median key handler lag ${med.toFixed(2)} ms`);
    assert.ok(over8 <= (CI ? 0.2 : 0.05), `${(over8 * 100).toFixed(0)}% of the key events reached the page more than 8 ms after their stamp`);
    const downs = ks.filter((e) => e[1] === 'keydown');
    const gaps = downs.slice(1).map((e, i) => e[4] - downs[i][4]);
    const share = latticeShare(gaps);
    assert.ok(share < 0.5, `lattice share of the keydown->keydown gaps ${share.toFixed(2)}`);
  });

  it('the wheel: gaps inside a flick are continuous, and no wheel event is dated in the future', () => {
    S.reset('fidelity');
    S.clearLog();
    // 6000 px = ~55 events and ~35 intra-flick gaps (the scroller is 9000 px tall). A continuous gap is within 1 ms of the lattice
    // 12-15% of the time (measured, ~540 gaps): with 2400 px (~14 gaps) one of 16 measured runs scored 0.46, and a share of 0.5 was a
    // ~1-in-800 event; with ~35 gaps it is ~1 in 2 000 000. Lattice-bound gaps score ~0.9-1.0.
    S.ok(['scroll', '6000', '--target=#scroller']);
    const ws = S.log().filter((e) => e[0] === 'w');                      // ['w', dx, dy, timeStamp, lag, trusted]
    assert.ok(ws.length >= 30, `${ws.length} wheel events`);
    assert.ok(Math.min(...ws.map((e) => e[4])) >= -0.5, 'no wheel event is dated in the future');
    const gaps = ws.slice(1).map((e, i) => e[3] - ws[i][3]).filter((g) => g < 60);        // inside a flick; the reading pauses between flicks are longer
    assert.ok(gaps.length >= 20, `${gaps.length} intra-flick gaps`);
    const share = latticeShare(gaps);
    assert.ok(share < 0.5, `lattice share of the intra-flick wheel gaps ${share.toFixed(2)}: ${gaps.map((g) => g.toFixed(1)).join(' ')}`);
  });

  it('fill clears with the platform\'s select-all through the key emitter, also while the page layout is Russian (the physical key, not Playwright\'s "A")', () => {
    const f = new Session(MAIN);
    f.newPage('fill-ru');
    try {
      f.go('keys');
      f.ok(['click', '#in']);
      f.ok(['type-focused', 'привет', '--typos=off', '--seed=3'], { timeout: 120_000 });           // leaves the page layout on Russian
      assert.equal(f.pageInfo().input.layout, 'ru');
      f.clearLog();
      f.ok(['fill', '#in', 'x1', '--typos=off', '--seed=5'], { timeout: 120_000 });
      assert.equal(f.eval('document.getElementById("in").value'), 'x1', 'the old text was cleared before typing');
      const mac = process.platform === 'darwin';
      const ks = keyLog(f.log());
      const sel = ks.find((e) => e[1] === 'keydown' && e[3] === 'KeyA');
      assert.ok(sel, 'a select-all key was pressed');
      assert.equal(mac ? sel[9] : sel[7], true, mac ? 'with Cmd held (Ctrl+A moves the caret on macOS)' : 'with Ctrl held');
      assert.equal(mac ? sel[7] : sel[9], false, 'and not with the other one');
      if (!mac) assert.equal(sel[2], 'ф', 'the key that types ф on the Russian layout: the physical A key, not Playwright\'s "a"');
      f.expectNothingHeld('after fill');
    } finally { f.ok(['close']); }
  });
});

// ===========================================================================
// touch (gated)
// ===========================================================================

describe('touch gestures are refused unless the page reports touch capability', () => {
  it('a normal (mouse-only) daemon refuses tap / tap-at / swipe / pinch with an explanation, and dispatches nothing', () => {
    S.reset('canvas');
    for (const args of [['tap', '#btn'], ['tap-at', '100', '100'], ['swipe', '100', '300', '100', '100'], ['pinch', '200', '200', '--scale=2']]) {
      const e = S.bad(args);
      assert.match(e.error, /touch refused/);
      assert.match(e.error, /maxTouchPoints=0/);
      assert.match(e.error, /NATIVEWRIGHT_TOUCH=1/);
    }
    assert.equal(S.log().filter((e) => e[0] === 't').length, 0, 'no touch events were dispatched');
    assert.equal(S.eval('navigator.maxTouchPoints'), 0);
  });

  it('F2 (the other direction): a normal daemon reports a fine pointer + hover, so the mouse commands are allowed on it', () => {
    S.reset('canvas');
    const mq = S.evalJson(`({ anyFine: matchMedia('(any-pointer: fine)').matches, pointerFine: matchMedia('(pointer: fine)').matches,
      anyCoarse: matchMedia('(any-pointer: coarse)').matches, anyHover: matchMedia('(any-hover: hover)').matches, hoverHover: matchMedia('(hover: hover)').matches })`);
    assert.deepEqual(mq, { anyFine: true, pointerFine: true, anyCoarse: false, anyHover: true, hoverHover: true });
    const b = S.center('#btn');
    S.ok(['click-at', String(Math.round(b.x)), String(Math.round(b.y))]);
    assert.ok(mouseLog(S.log()).some((e) => e[1] === 'click'), 'a mouse click was dispatched and accepted');
  });
});

describe('touch gestures on an opt-in touch-capable daemon (NATIVEWRIGHT_TOUCH=1)', () => {
  before(async () => {
    await startDaemon(TOUCH);
    T.newPage('touch');
    T.go('canvas');
  });

  it('reports a self-consistent touch capability: maxTouchPoints 10, ontouchstart, and the touch-ONLY media profile the F2 gate keys on', (t) => {
    const fp = T.evalJson(`({ mtp: navigator.maxTouchPoints, ots: 'ontouchstart' in window,
      ptrFine: matchMedia('(pointer: fine)').matches, ptrCoarse: matchMedia('(pointer: coarse)').matches,
      anyFine: matchMedia('(any-pointer: fine)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches,
      hoverHover: matchMedia('(hover: hover)').matches, hoverNone: matchMedia('(hover: none)').matches,
      anyHover: matchMedia('(any-hover: hover)').matches, anyHoverNone: matchMedia('(any-hover: none)').matches })`);
    assert.equal(fp.mtp, 10);
    assert.equal(fp.ots, true);
    const st = T.ok(['state']);
    assert.equal(st.touch, true);
    // Chrome 149 gives a touch-capable page a TOUCH-ONLY (tablet-class) pointer profile and offers no way to express "touch AND mouse"
    // (setEmulatedMedia ignores these features; --touch-events=enabled alone leaves maxTouchPoints at 0): record what it really reports,
    // and assert it, because the modality gate (mouse commands refused) is built on exactly these values
    t.diagnostic(`touch daemon media profile: ${JSON.stringify(fp)}`);
    assert.deepEqual({ ptrFine: fp.ptrFine, ptrCoarse: fp.ptrCoarse, anyFine: fp.anyFine, anyCoarse: fp.anyCoarse, hoverHover: fp.hoverHover, hoverNone: fp.hoverNone, anyHover: fp.anyHover, anyHoverNone: fp.anyHoverNone },
      { ptrFine: false, ptrCoarse: true, anyFine: false, anyCoarse: true, hoverHover: false, hoverNone: true, anyHover: false, anyHoverNone: true });
    // pages opened later get the same capability (not the intermediate maxTouchPoints=1)
    const p2 = new Session(TOUCH);
    p2.newPage('touch2');
    try {
      assert.equal(p2.ok(['eval', 'navigator.maxTouchPoints']).value, 10);
      assert.equal(p2.evalJson("matchMedia('(any-pointer: fine)').matches"), false, 'a later page is touch-only as well, so the gate holds for it too');
    } finally { p2.ok(['close']); }
  });

  it('F2: a touch-only profile REFUSES every mouse-dispatching command (--raw included), dispatches nothing, and names the commands that do work', () => {
    T.reset('canvas');
    assert.equal(T.pointer(), null, 'no mouse pointer exists on this page');
    const cases = [
      ['click', '#btn'], ['click', '#btn', '--raw=true'], ['dblclick', '#btn'], ['rightclick', '#btn'],
      ['hover', '#btn'], ['hover', '#btn', '--raw=true'],
      ['click-at', '100', '100'], ['click-at', '100', '100', '--raw=true'],
      ['hover-at', '100', '100'], ['hover-at', '100', '100', '--raw=true'],
      ['drag', '#btn', '#cv'], ['drag', '#btn', '#cv', '--raw=true'],
      ['drag-at', '10', '10', '100', '100'], ['drag-at', '10', '10', '100', '100', '--raw=true'],
      ['mouse-down'], ['mouse-down', '--raw=true'], ['mouse-up'], ['mouse-up', '--raw=true'],
      ['scroll', 'down'], ['scroll', 'down', '--raw=true'], ['scroll', 'bottom'],
      ['calibrate-wheel', '--seconds=1', '--simulate=true'],
    ];
    for (const args of cases) {
      const e = T.bad(args);
      const what = args[0] === 'calibrate-wheel' ? 'calibrate-wheel --simulate' : args[0];
      assert.match(e.error, /mouse input refused/, `${args.join(' ')}: ${e.error}`);
      assert.ok(e.error.includes('`' + what + '`'), `${args.join(' ')} names itself in the refusal`);
      assert.match(e.error, /any-pointer: fine/);
      for (const alt of ['tap', 'swipe', 'pinch', 'type-focused', 'paste-focused', 'press', 'drop-files']) assert.ok(e.error.includes(alt), `${args.join(' ')}: the refusal names ${alt}`);
    }
    let log = T.log();
    assert.equal(mouseLog(log).length, 0, 'no mouse events reached the page');
    assert.equal(log.filter((e) => e[0] === 'w' || e[0] === 'pd' || e[0] === 'pm').length, 0, 'no wheel / pointer events either');
    assert.equal(T.pointer(), null, 'the pointer was never created');
    assert.deepEqual(T.held(), { buttons: [], keys: [] });

    // the selector text commands click their field first: refused too (also --raw), and the page is left untouched
    T.reset('keys');
    for (const args of [['fill', '#in', 'x'], ['fill', '#in', 'x', '--raw=true'], ['type', '#in', 'x'], ['type', '#in', 'x', '--raw=true'],
      ['select', '#sel', 'b'], ['select', '#sel', 'b', '--raw=true'], ['paste', '#in', 'x'], ['paste', '#in', 'x', '--raw=true']]) {
      const e = T.bad(args);
      assert.match(e.error, /mouse input refused/, `${args.join(' ')}: ${e.error}`);
      assert.ok(e.error.includes('`' + args[0] + '`'));
    }
    assert.equal(T.eval('document.getElementById("in").value'), '');
    assert.equal(T.eval('document.getElementById("sel").value'), 'a');
    assert.equal(T.eval('document.activeElement.tagName'), 'BODY', 'nothing was focused');
    log = T.log();
    assert.equal(keyLog(log).length, 0, 'no key events either');
    assert.equal(T.pointer(), null);
  });

  it('F2: the touch workflow - tap a field, then type-focused / paste-focused / press / key-down / key-up / release; element-at and shot still work', () => {
    T.reset('keys');
    T.ok(['tap', '#in']);
    assert.equal(T.eval('document.activeElement.id'), 'in', 'the tap focused the field (tap, then keyboard)');
    const r = T.ok(['type-focused', 'touch typed']);
    assert.equal(r.typed, 11);
    assert.equal(T.eval('document.getElementById("in").value'), 'touch typed');
    T.ok(['press', process.platform === 'darwin' ? 'Meta+a' : 'Control+a']);          // select all: Cmd+A on macOS
    T.ok(['press', 'Backspace']);
    assert.equal(T.eval('document.getElementById("in").value'), '');
    const p = T.ok(['paste-focused', 'pasted by touch user'], { timeout: 240_000 });
    assert.ok(['paste', 'typed'].includes(p.method));
    assert.equal(T.eval('document.getElementById("in").value'), 'pasted by touch user');
    T.ok(['key-down', 'Shift']);
    assert.deepEqual(T.held(), { buttons: [], keys: ['Shift'] });
    T.ok(['key-up', 'Shift']);
    T.ok(['key-down', 'Shift']);
    T.ok(['release']);
    T.expectNothingHeld('after release');
    const m = T.metrics();
    assert.equal(T.ok(['element-at', '30', '30']).viewport.width, m.w, 'element-at is read-only and allowed');
    assert.ok(T.ok(['shot']).path, 'shot is allowed');
    assert.equal(T.pointer(), null, 'not a single mouse input happened');
    assert.equal(mouseLog(T.log()).length, 0);
  });

  it('F2: an off-screen tap target is reached with FINGER DRAGS, never a wheel; swipe scrolls too', () => {
    T.reset('tall');
    const r = T.ok(['tap', '#far'], { timeout: 120_000 });
    const log = T.log();
    assert.equal(log.filter((e) => e[0] === 'w').length, 0, 'no wheel events: a touch-only device has no wheel');
    const starts = log.filter((e) => e[0] === 't' && e[1] === 'touchstart');
    assert.ok(starts.length >= 3, `scrolling took several finger drags before the final tap (${starts.length} touchstarts)`);
    assert.ok(starts.every((e) => e[5] === true), 'trusted touches');
    assert.ok(+T.eval('document.documentElement.dataset.touchmoves') > 10, 'frame-paced touchmoves');
    const click = log.find((e) => e[0] === 'far-click');
    assert.ok(click && click[3] === true, 'the final tap clicked #far');
    assert.ok(+T.eval('scrollY') > 1500, 'the page really scrolled');
    assert.ok(r.at.x > 0 && r.at.y > 0);
    assert.equal(T.pointer(), null, 'no mouse pointer was created on the way');
    // swipe-to-scroll, the documented replacement for `scroll`
    T.go('tall');
    const m = T.metrics();
    T.ok(['swipe', String(Math.round(m.w / 2)), String(Math.round(m.h * 0.8)), String(Math.round(m.w / 2)), String(Math.round(m.h * 0.2))]);
    assert.ok(+T.eval('scrollY') > 100);
    assert.equal(T.log().filter((e) => e[0] === 'w').length, 0);
  });

  it('F2: drop-files (an OS file drag, not pointer input) is allowed on the touch-only profile and leaves the mouse state alone', () => {
    T.reset('drop');
    fs.writeFileSync(path.join(TOUCH.work, 'touch.txt'), 'dropped on touch');
    const r = T.ok(['drop-files', '#zone', 'touch.txt']);
    assert.equal(r.files[0].name, 'touch.txt');
    const drop = T.log().find((e) => e[0] === 'drop');
    assert.ok(drop && drop[1] === true && drop[3][0].text === 'dropped on touch', 'a trusted drop with the real file');
    assert.equal(T.pointer(), null, 'no mouse move was synced to the drop point');
    assert.equal(mouseLog(T.log()).length, 0);
  });

  it('tap / tap-at: trusted touchstart + touchend, then the click they produce; the mouse pointer is not moved', () => {
    T.reset('canvas');
    const ptr = T.pointer();
    const b = T.rect('#btn');
    const r = T.ok(['tap', '#btn']);
    assert.ok(r.at.x >= b.x && r.at.x <= b.x + b.width);
    let log = T.log();
    const ts = log.filter((e) => e[0] === 't').map((e) => e[1]);
    assert.deepEqual(ts, ['touchstart', 'touchend']);
    assert.ok(log.filter((e) => e[0] === 't').every((e) => e[5] === true), 'trusted');
    assert.ok(mouseLog(log).some((e) => e[1] === 'click' && e[11] === 'btn'), 'the tap clicked the button');
    T.clearLog();
    const c = T.center('#btn');
    T.ok(['tap-at', String(Math.round(c.x)), String(Math.round(c.y))]);
    log = T.log();
    assert.ok(log.some((e) => e[0] === 't' && e[1] === 'touchstart') && mouseLog(log).some((e) => e[1] === 'click'));
    assert.deepEqual(T.pointer(), ptr, 'touch does not move the mouse pointer');
  });

  it('swipe scrolls with a frame-paced touch path; pinch uses two contacts and zooms the visual viewport', () => {
    T.reset('tall');
    const before = +T.eval('scrollY');
    const m = T.metrics();
    const r = T.ok(['swipe', String(Math.round(m.w / 2)), String(Math.round(m.h * 0.8)), String(Math.round(m.w / 2)), String(Math.round(m.h * 0.2))]);
    assert.ok(r.durationMs > 100);
    assert.ok(+T.eval('scrollY') > before + 100, 'the swipe scrolled the page');
    // pinch over a plain page: an element with `touch-action: none` (the canvas fixture's #cv) legitimately disables pinch-zoom
    T.go('tall');
    const scale0 = +T.eval('visualViewport.scale');
    const r2 = T.ok(['pinch', '250', '200', '--scale=2']);
    assert.ok(r2.spanTo > r2.spanFrom, 'two fingers spread apart');
    assert.ok(+T.eval('visualViewport.scale') > scale0, 'pinch out zoomed in');
    const e = T.bad(['pinch', '250', '200', '--scale=0']);
    assert.match(e.error, /bad --scale/);
    assert.deepEqual(T.held(), { buttons: [], keys: [] });
  });
});

// ===========================================================================
// the install pointer
// ===========================================================================

describe('install pointer: <data root>/install.json belongs to the INSTALLED package', () => {
  // Every daemon start used to overwrite the pointer, so one start from a git clone sent the tools that find the CLI through this
  // file (when `nativewright` is not on their PATH) to unreleased working-tree code on the real profile. The rule, run here through
  // the real module in a child process with its own NATIVEWRIGHT_HOME: write the pointer only when there is none, the old one dangles,
  // or this start is an installed package (a node_modules segment in the real path). A checkout or `npm link` never replaces a valid one.
  it('a checkout start keeps a valid pointer to another path and creates one only when none exists; a dangling pointer is replaced; an installed package overwrites', () => {
    const home = mkTmp('install-home');
    const root = mkTmp('install-scripts');
    try {
      const script = (...parts) => { const f = path.join(root, ...parts); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '// browser.js'); return f; };
      const installedA = script('global', 'node_modules', 'nativewright', 'src', 'browser.js');
      const installedB = script('other', 'node_modules', 'nativewright', 'src', 'browser.js');
      const cloneA = script('cloneA', 'src', 'browser.js');
      const cloneB = script('cloneB', 'src', 'browser.js');
      const pointerFile = path.join(home, 'install.json');
      const logFile = path.join(home, 'logs', 'daemon.log');
      const start = (scriptPath) => {
        const code = `const cfg = require(${JSON.stringify(path.join(REPO, 'src', 'config.js'))}); cfg.writeInstallFile(process.env.SCRIPT_PATH).then((r) => process.stdout.write(JSON.stringify(r)));`;
        const env = { ...envFor({ home, profile: home, artifacts: home }), SCRIPT_PATH: scriptPath };
        const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
      };
      const pointer = () => JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
      const declines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => /install pointer kept/.test(l)) : []);

      // (a) no pointer: a checkout may create one
      let r = start(cloneA);
      assert.deepEqual([r.written, r.reason], [true, 'no pointer yet']);
      assert.equal(pointer().scriptPath, cloneA);
      assert.ok(pointer().installedAt && pointer().node === process.version && pointer().platform === process.platform, 'the usual fields');
      // a valid pointer to ANOTHER checkout is kept, with one log line that names both paths
      r = start(cloneB);
      assert.deepEqual([r.written, r.reason, r.kept], [false, 'valid pointer to another path', cloneA]);
      assert.equal(pointer().scriptPath, cloneA, 'unchanged');
      assert.equal(declines().length, 1);
      assert.ok(declines()[0].includes(cloneA) && declines()[0].includes(cloneB), declines()[0]);
      // the same checkout again is a no-op, not a decline
      r = start(cloneA);
      assert.deepEqual([r.written, r.reason], [false, 'already points here']);
      assert.equal(declines().length, 1, 'no extra log line');
      // (c) an installed package overwrites a valid pointer to a checkout...
      r = start(installedA);
      assert.deepEqual([r.written, r.reason], [true, 'installed package']);
      assert.equal(pointer().scriptPath, installedA);
      // ...and a checkout start (npm link included: its real path is the checkout) must not take it back
      r = start(cloneB);
      assert.deepEqual([r.written, r.kept], [false, installedA]);
      assert.equal(pointer().scriptPath, installedA, 'a pointer to an installed package survives a checkout start');
      assert.equal(declines().length, 2);
      // another installed package (a reinstall elsewhere, npx) overwrites
      r = start(installedB);
      assert.deepEqual([r.written, r.reason], [true, 'installed package']);
      assert.equal(pointer().scriptPath, installedB);
      // (b) a pointer whose script no longer exists is replaced by a checkout start
      fs.writeFileSync(pointerFile, JSON.stringify({ scriptPath: path.join(root, 'gone', 'src', 'browser.js') }));
      r = start(cloneA);
      assert.deepEqual([r.written, r.reason], [true, 'the existing pointer is dangling']);
      assert.equal(pointer().scriptPath, cloneA);
      // (a) a corrupt pointer, or one without a scriptPath, counts as none
      fs.writeFileSync(pointerFile, '{ not json');
      r = start(cloneB);
      assert.deepEqual([r.written, r.reason], [true, 'no pointer yet']);
      assert.equal(pointer().scriptPath, cloneB);
      fs.writeFileSync(pointerFile, JSON.stringify({ installedAt: 'x' }));
      assert.equal(start(cloneA).written, true);
      assert.equal(pointer().scriptPath, cloneA);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// lifecycle
// ===========================================================================

describe('lifecycle', () => {
  it('closing a page releases whatever it still holds (best effort) and leaves the daemon healthy', () => {
    const f = new Session(MAIN);
    f.newPage('closing');
    f.go('canvas');
    f.ok(['key-down', 'Shift']);
    f.ok(['hover-at', '100', '100', '--exact=true']);
    f.ok(['mouse-down']);
    assert.deepEqual(f.held(), { buttons: ['left'], keys: ['Shift'] });
    f.ok(['close']);
    assert.equal(cli(MAIN, ['pages']).body.result.some((p) => p.page === f.page), false);
    S.expectNothingHeld();
  });

  it('help (CLI usage text) and the daemon\'s command list cover every new command; unknown commands still fail cleanly', async () => {
    const NEW = ['click-at', 'hover-at', 'element-at', 'drag', 'drag-at', 'mouse-down', 'mouse-up', 'key-down', 'key-up', 'release',
      'type-focused', 'paste', 'paste-focused', 'calibrate-wheel', 'tap', 'tap-at', 'swipe', 'pinch', 'drop-files', 'select', 'scroll', 'shot'];
    // `nativewright help` is answered locally by the CLI (usage text)
    const usage = spawnSync(process.execPath, [ENTRY, 'help'], { env: MAIN.env, encoding: 'utf8' }).stdout;
    for (const c of NEW) assert.ok(new RegExp(`\\b${c}\\b`).test(usage), `usage text mentions ${c}`);
    // the daemon's own `help` command, over its HTTP API (the lockfile holds the port)
    const lock = JSON.parse(fs.readFileSync(path.join(MAIN.home, 'daemon.json'), 'utf8'));
    const reply = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ cmd: 'help', args: {}, cwd: MAIN.work });
      const req = require('node:http').request({ host: '127.0.0.1', port: lock.port, path: '/cmd', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve(JSON.parse(buf)));
      });
      req.on('error', reject); req.end(body);
    });
    assert.equal(reply.ok, true);
    for (const c of NEW) assert.ok(reply.result.commands.includes(c), `daemon help lists ${c}`);
    assert.equal(cli(MAIN, ['no-such-command']).exitCode, 1);
  });
});
