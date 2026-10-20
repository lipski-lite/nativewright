'use strict';

// Minimal sanity checks for src/human.js. Run: `node src/human.sanity.js`.
// Verifies the math matches human-realistic distributions. No browser needed.

const h = require('./human');
const timing = require('./timing');
const { performance } = require('perf_hooks');
const CI = !!process.env.CI;                // shared CI VMs are slower and noisier: the timing checks relax (never the structural ones)

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  ', msg);
}

function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(v);
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    n, mean, sd,
    min: sorted[0], max: sorted[n - 1],
    p50: sorted[Math.floor(n * 0.5)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.floor(n * 0.99)],
  };
}

// ---- 1) RNG reproducibility --------------------------------------------
{
  const a = h.makeRng(12345);
  const b = h.makeRng(12345);
  const vA = []; const vB = [];
  for (let i = 0; i < 100; i++) { vA.push(a()); vB.push(b()); }
  assert(vA.every((x, i) => x === vB[i]), 'seeded RNG is reproducible');

  const c = h.makeRng(12346);
  const vC = []; for (let i = 0; i < 100; i++) vC.push(c());
  assert(vA.some((x, i) => x !== vC[i]), 'different seed → different sequence');
}

// ---- 2) Gaussian distribution ------------------------------------------
{
  const rng = h.makeRng(1);
  const xs = [];
  for (let i = 0; i < 20000; i++) xs.push(h.gaussian(rng));
  const s = stats(xs);
  assert(Math.abs(s.mean) < 0.05, `gaussian mean ≈ 0 (got ${s.mean.toFixed(3)})`);
  assert(Math.abs(s.sd - 1) < 0.05, `gaussian sd ≈ 1 (got ${s.sd.toFixed(3)})`);
}

// ---- 3) Log-normal timing ---------------------------------------------
{
  const rng = h.makeRng(2);
  const xs = [];
  for (let i = 0; i < 20000; i++) xs.push(h.logNormal(rng, 110, 0.35, 10, 2000));
  const s = stats(xs);
  // median of log-normal = exp(mu) = meanMs; mean is slightly higher
  assert(s.p50 > 90 && s.p50 < 135, `log-normal median near 110 (got ${s.p50.toFixed(0)})`);
  assert(s.p95 > 170 && s.p95 < 230, `log-normal p95 realistic (got ${s.p95.toFixed(0)})`);
  assert(s.min >= 10, 'log-normal respects min clamp');
  assert(s.max <= 2000, 'log-normal respects max clamp');
}

// ---- 4) Path generation -----------------------------------------------
{
  const rng = h.makeRng(3);
  const from = { x: 100, y: 100 };
  const to = { x: 700, y: 400 };
  const { path, steps } = h.samplePath(from, to, rng);
  assert(steps >= 8, 'path has ≥ 8 steps');
  // hesitation samples may append a few extra points
  assert(path.length >= steps, 'path length ≥ step count (hesitation may append)');
  assert(path.length < steps + 10, 'hesitation does not explode path length');

  const last = path[path.length - 1];
  assert(last.x === to.x && last.y === to.y, 'final path point equals target');

  // total path length should exceed direct distance (it's curved + jittered)
  let total = 0;
  let prev = from;
  for (const p of path) { total += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
  const direct = Math.hypot(to.x - from.x, to.y - from.y);
  assert(total > direct, `curved path (${total.toFixed(0)}) longer than direct (${direct.toFixed(0)})`);
  assert(total < direct * 2, 'path not absurdly long');
}

// ---- 5) pointInBox never dead-center, always inside --------------------
{
  const rng = h.makeRng(4);
  const box = { x: 100, y: 100, width: 200, height: 40 };
  let centerHits = 0, inside = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const p = h.pointInBox(box, rng);
    if (p.x > box.x && p.x < box.x + box.width &&
        p.y > box.y && p.y < box.y + box.height) inside += 1;
    if (Math.abs(p.x - (box.x + box.width / 2)) < 0.5 &&
        Math.abs(p.y - (box.y + box.height / 2)) < 0.5) centerHits += 1;
  }
  assert(inside === N, `all ${N} samples inside box`);
  assert(centerHits < 50, `rarely lands exactly at center (got ${centerHits}/${N})`);
}

// ---- 6) charBaseMs sanity ---------------------------------------------
{
  assert(h.charBaseMs('a') < h.charBaseMs('A'), 'uppercase slower than lowercase');
  assert(h.charBaseMs('a') < h.charBaseMs(' '), 'space slower than letter');
  assert(h.charBaseMs(',') > h.charBaseMs('a'), 'punctuation slower than letter');
}

// ---- 7) moveDurationMs grows with distance, shrinks with target size ---
{
  const rng = h.makeRng(5);
  // average over many samples to beat log-normal noise
  function avg(d, w) {
    let s = 0; const n = 500;
    for (let i = 0; i < n; i++) s += h.moveDurationMs(d, w, rng);
    return s / n;
  }
  const near = avg(50, 50);
  const far  = avg(800, 50);
  assert(far > near * 1.3, `far move takes longer than near (${near.toFixed(0)} vs ${far.toFixed(0)})`);
  const bigTarget   = avg(400, 100);
  const smallTarget = avg(400, 10);
  assert(smallTarget > bigTarget, `small target takes longer than big (${bigTarget.toFixed(0)} vs ${smallTarget.toFixed(0)})`);
}

// ---- 8) keyboard layouts (physical codes), keys, coordinates -------------
const layouts = require('./layouts');
const K = require('./keys');
const coords = require('./coords');
const wheel = require('./wheel');
{
  const ru = layouts.LAYOUTS.ru.byChar;
  const expectRu = { 'й': ['KeyQ', 81], 'ф': ['KeyA', 65], 'ж': ['Semicolon', 186], 'х': ['BracketLeft', 219],
    'ъ': ['BracketRight', 221], 'б': ['Comma', 188], 'ю': ['Period', 190], 'э': ['Quote', 222], 'ё': ['Backquote', 192] };
  assert(Object.entries(expectRu).every(([ch, [code, vk]]) => ru[ch] && ru[ch].code === code && ru[ch].vk === vk && ru[ch].key === ch && !ru[ch].shift),
    'RU letters sit on their physical codes with the physical key\'s virtual-key code and key = the character');
  assert(ru['Й'].code === 'KeyQ' && ru['Й'].shift && ru['Ё'].code === 'Backquote' && ru['Ё'].shift, 'RU capitals are Shift + the same physical key');
  assert(ru['.'].code === 'Slash' && !ru['.'].shift && ru[','].code === 'Slash' && ru[','].shift, "RU '.' is Slash, ',' is Shift+Slash");
  assert(ru['"'].code === 'Digit2' && ru['№'].code === 'Digit3' && ru[';'].code === 'Digit4' && ru[':'].code === 'Digit6' && ru['?'].code === 'Digit7' && ru['/'].code === 'Backslash' && ru['/'].shift,
    'RU shifted digit-row punctuation sits where the layout puts it');
  assert(layouts.EN.byChar['.'].code === 'Period', "EN '.' is Period");
  const sameBoth = ['1', '!', '%', '*', '(', ')', '-', '_', '=', '+', ' '];
  assert(sameBoth.every((c) => layouts.EN.byChar[c].code === ru[c].code && layouts.EN.byChar[c].shift === ru[c].shift),
    'digits, space and !%*()-_=+ share positions between EN and RU');
  assert(layouts.resolveChar('.', 'ru').desc.code === 'Slash' && layouts.resolveChar('.', 'ru').switchTo === null,
    "a char typable on both layouts ('.') uses the ACTIVE layout's key and needs no switch");
  assert(layouts.resolveChar('a', 'ru').switchTo === 'en' && layouts.resolveChar('й', 'en').switchTo === 'ru', 'a char only on the other layout requests a switch');
  assert(layouts.resolveChar('😀', 'en') === null && layouts.resolveChar('漢', 'ru') === null, 'chars on neither layout (emoji, CJK) resolve to null -> insertText');
  const rngT = h.makeRng(9);
  assert('йцыя'.includes(layouts.typoFor('ф', rngT, 'ru')), "RU typo for 'ф' (KeyA) is a Russian letter on a key next to A (q,w,s,z -> й,ц,ы,я)");
  assert(layouts.typoFor('х', h.makeRng(1), 'ru') === null, 'keys without mapped neighbours produce no typo');
  assert(layouts.withShiftHeld(layouts.EN.byChar['a']).key === 'A' && layouts.withShiftHeld(layouts.EN.byChar['1']).key === '!', 'with Shift held a physical key yields its shifted character');
  assert(JSON.stringify(K.splitCombo('Control++')) === '["Control","+"]' && K.splitCombo('Control+Shift+ArrowLeft').length === 3, 'combo splitting matches Playwright (Control++)');
  assert(K.parseModifierList('ctrl, SHIFT,cmd').mask === (2 | 8 | 4) && K.canonicalModifier('Win') === 'Meta' && K.canonicalModifier('Option') === 'Alt', 'modifier aliases (Ctrl/Cmd/Win/Option) and mask bits');
  let threw = false; try { K.parseModifierList('Hyper'); } catch { threw = true; }
  assert(threw, 'unknown modifier throws');

  const vp = { width: 1000, height: 600, dpr: 1.5 };
  const p = coords.resolvePoint(300, 150, 'screenshot', vp);
  assert(p.css.x === 200 && p.css.y === 100, 'screenshot space divides by dpr (300,150 @1.5 -> 200,100)');
  let msg = ''; try { coords.resolvePoint(1500, 100, 'css', vp); } catch (e) { msg = e.message; }
  assert(/outside the viewport/.test(msg) && /1000x600/.test(msg) && /dpr 1.5/.test(msg) && /converted to css/.test(msg), 'out-of-viewport error states viewport size, dpr and the converted css values');
  assert(['10px', '', 'abc', NaN, Infinity, '20 junk', true].every((v) => { try { coords.parseNumber(v, 'x'); return false; } catch { return true; } }), 'numeric parsing is strict');
  msg = ''; try { coords.resolveOffset({ x: 500, y: 5 }, 'css', vp, { x: 10, y: 10, width: 100, height: 40 }); } catch (e) { msg = e.message; }
  assert(/outside the element box/.test(msg) && /dpr 1.5/.test(msg), '--at outside the box is an error that states dpr');
}

// ---- 9) landing jitter, Fitts width, wheel quantisation + calibration ------
{
  const rng = h.makeRng(21);
  let worst = 0, outside = 0;
  for (let i = 0; i < 20000; i++) {
    const q = h.jitterPoint({ x: 100, y: 100 }, rng, null, false);
    worst = Math.max(worst, Math.hypot(q.x - 100, q.y - 100));
    const e = h.jitterPoint({ x: 0.2, y: 99.9 }, rng, { x0: 0, y0: 0, x1: 100, y1: 100 }, false);
    if (e.x < 0 || e.x >= 100 || e.y < 0 || e.y >= 100) outside += 1;
  }
  assert(worst <= 2.0000001, `landing jitter radius is clamped to 2px (worst ${worst.toFixed(3)})`);
  assert(outside === 0, 'landing point is clamped inside the viewport/box');
  const ex = h.jitterPoint({ x: 55, y: 66 }, rng, null, true);
  assert(ex.x === 55 && ex.y === 66, '--exact skips the jitter');
  assert(h.fittsWidth({ box: { width: 400, height: 300 } }) === 200 && h.fittsWidth({ box: { width: 3, height: 50 } }) === 8 && h.fittsWidth(null) === 20, 'Fitts width = min(w,h) clamped to [8,200] (20 when nothing was hit)');

  const u = { logNormal: h.logNormal, gaussian: h.gaussian };
  const evs = wheel.plan(wheel.DEFAULT_MODEL, h.makeRng(5), u, 3000);
  const total = evs.reduce((a, e) => a + e.delta, 0);
  assert(evs.every((e) => e.delta % 100 === 0 && e.delta >= 100), 'default wheel emits whole notches (multiples of 100)');
  assert(Math.abs(total - 3000) <= 50, `quantised distance lands within half a notch of the request (${total} for 3000)`);
  assert(wheel.plan(wheel.DEFAULT_MODEL, h.makeRng(5), u, 30).length === 1, 'a small non-zero request still sends one notch');
  const intra = evs.filter((e) => !e.endOfFlick).map((e) => e.gapMs);
  assert(intra.length > 5 && intra.every((g) => g >= 15 && g <= 40), 'intra-flick gaps are 15-40 ms');
  assert(evs.some((e) => e.delta > 100) && evs.filter((e) => e.delta > 100).length < evs.length * 0.4, 'multi-notch events are occasional');

  // calibration: synthetic human-ish wheel -> profile; too few events rejected
  const synth = []; let t = 1000;
  const r2 = h.makeRng(8);
  for (let b = 0; b < 12; b++) { const n = 1 + Math.floor(r2() * 5); for (let i = 0; i < n; i++) { synth.push({ t, dx: 0, dy: r2() < 0.9 ? 66.67 : 133.33, mode: 0 }); t += 18 + r2() * 20; } t += 250 + r2() * 700; }
  const prof = wheel.deriveProfile(synth, { source: 'human', dpr: 1.5 });
  assert(prof.events === synth.length && Math.abs(prof.quantum - 66.67) < 0.01 && prof.quantised && prof.version === wheel.CAL_VERSION, `calibration finds the device quantum (${prof.quantum})`);
  assert(prof.intraGap.median > 15 && prof.intraGap.median < 45 && prof.interGap.median > 200, 'calibration separates intra-flick from inter-flick gaps');
  const m = wheel.modelFromProfile(prof);
  const evs2 = wheel.plan(m, h.makeRng(2), u, 1000);
  assert(evs2.every((e) => Math.abs(e.delta / 66.67 - Math.round(e.delta / 66.67)) < 0.01), 'calibrated model emits the device\'s own deltas');
  let rej = null; try { wheel.deriveProfile(synth.slice(0, 19), {}); } catch (e) { rej = e; }
  assert(rej && rej.code === 'TOO_FEW_EVENTS' && /at least 20/.test(rej.message), 'a calibration with fewer than 20 events is rejected with a clear message');

  const cb = require('./clipboard');
  assert(cb._classifyWindows(['UnicodeText', 'Text', 'OEMText', 'Locale']).kind === 'text', 'plain-text clipboard formats classify as text');
  assert(cb._classifyWindows([]).kind === 'empty', 'no formats = empty clipboard');
  assert(['Bitmap', 'FileDrop', 'HTML Format', 'Rich Text Format'].every((f) => cb._classifyWindows(['UnicodeText', f]).kind === 'other'), 'images, file lists and rich formats are NOT plain text -> never touched');
  assert(['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'].every((f) => cb._classifyWindows(['UnicodeText', 'Text', f]).kind === 'other'),
    'a HUMAN clipboard that carries one of the payload flag formats (password managers do) is not plain text -> never touched or read');
  {
    // the helper script is passed as -EncodedCommand (UTF-16 base64): it must stay far below the 32767-char command line limit
    for (const fake of [false, true]) {
      const n = Buffer.from(cb._workerScript(fake), 'utf16le').toString('base64').length;
      assert(n < 28000, `the ${fake ? 'in-memory' : 'real'} clipboard helper script fits the command line (${n} chars encoded)`);
    }
    const real = cb._workerScript(false);
    assert(/ReadLineAsync/.test(real) && /Wait\(200\)/.test(real) && /DoEvents/.test(real) && !/\[Console\]::In\.ReadLine/.test(real), 'the real helper reads stdin asynchronously and pumps window messages while idle (a helper parked in a blocking ReadLine made other applications\' clipboard writes wait ~5 s)');
    assert(/SetDataObject\(\$do, \$true, \d+, \d+\)/.test(real) && /ExcludeClipboardContentFromMonitorProcessing/.test(real) && /CanIncludeInClipboardHistory/.test(real) && /CanUploadToCloudClipboard/.test(real), 'the payload write copies (renders) a DataObject that carries the three flag formats, with bounded retries');
    assert(/\$OurFormats = \$TextFormats \+ \$PayloadFormats/.test(real) && /ClipRead \$OurFormats/.test(real), 'the restore recognises plain text + the payload flag formats as "ours"');
  }
  {
    // the clipboard lock is per OS user and machine-wide (os.tmpdir()), never under a NATIVEWRIGHT_HOME data root
    const os = require('os'), path = require('path');
    const lp = cb.lockPath();
    assert(path.dirname(lp) === os.tmpdir() && /^nativewright-clipboard(-\d+)?\.lock$/.test(path.basename(lp)), `the clipboard lock lives in os.tmpdir() (${lp})`);
    assert(!lp.startsWith(require('./config').BASE_HOME + path.sep), 'and not under the NativeWright data root');
  }
}

// ---- 10) humanType against a mocked CDP page: typos flag, layouts, Shift ----
// Every human pause goes through timing.preciseSleep / coarseSleep, which really wait. The maths is what is tested here, so the
// mocked runs use VIRTUAL TIME: a sleep only moves the clock, and each recorded event carries the virtual time it was sent at (`t`).
async function inVirtualTime(fn) {
  timing._useVirtualClock(true);
  try { return await fn(); } finally { timing._useVirtualClock(false); }
}
// `metrics`: what the page reports for window.innerWidth / innerHeight / devicePixelRatio (viewportMetrics asks through evaluate)
function mockPage(metrics) {
  const events = [];
  const cdp = { async send(method, params) { events.push({ m: method, ...params, t: timing.now(), sentAtSec: timing.nowSec() }); } };
  const page = {
    async evaluate() { return metrics ? { width: metrics.width, height: metrics.height, dpr: metrics.dpr, scrollX: 0, scrollY: 0 } : false; },
    context() { return { newCDPSession: async () => cdp }; },
    keyboard: {
      async down(k) { events.push({ pw: 'down', key: k, t: timing.now() }); },
      async up(k) { events.push({ pw: 'up', key: k, t: timing.now() }); },
      async press(k) { events.push({ pw: 'press', key: k, t: timing.now() }); },
      async insertText(t) { events.push({ pw: 'insertText', text: t, t: timing.now() }); },
    },
    mouse: {
      async move(x, y) { events.push({ pw: 'move', x, y, t: timing.now() }); },
      async down() { events.push({ pw: 'mdown', t: timing.now() }); },
      async up() { events.push({ pw: 'mup', t: timing.now() }); },
      async wheel() {},
    },
    viewportSize() { return null; },
  };
  return { page, events };
}
async function typeMocked(text, opts, setup) {
  const mp = mockPage();
  if (setup) await setup(mp.page);
  await inVirtualTime(() => h.humanType(mp.page, text, opts));
  return mp.events;
}
const downs = (ev) => ev.filter((e) => e.m === 'Input.dispatchKeyEvent' && e.type !== 'keyUp');
const backspaces = (ev) => downs(ev).filter((e) => e.code === 'Backspace').length;

(async () => {
  const text = 'the quick brown fox jumps over the lazy dog and keeps running through the green meadow until the sun goes down behind hills';
  const off = await typeMocked(text, { rng: h.makeRng(1), typos: 'off' });
  assert(backspaces(off) === 0, `--typos=off on a ${text.length}-char text produces zero Backspace keydowns`);
  let seed = -1;
  for (let s = 1; s <= 400 && seed < 0; s++) if (backspaces(await typeMocked(text, { rng: h.makeRng(s), typos: 'on' })) > 0) seed = s;
  assert(seed > 0, `--typos=on produces Backspace corrections for some seed (first: ${seed})`);
  const a = await typeMocked(text, { rng: h.makeRng(seed), typos: 'on' });
  const b = await typeMocked(text, { rng: h.makeRng(seed), typos: 'on' });
  assert(JSON.stringify(a.map((e) => [e.code, e.type])) === JSON.stringify(b.map((e) => [e.code, e.type])), 'a seeded run reproduces the same keystrokes');
  const pwd = await typeMocked(text, { rng: h.makeRng(seed) }, (pg) => { pg.evaluate = async () => true; });
  assert(backspaces(pwd) === 0, "typos 'auto' stays off for password-like fields");

  // Russian + English + emoji
  const mix = await typeMocked('Hi Мир! 😀 ok', { rng: h.makeRng(3), typos: 'off' });
  const kd = downs(mix);
  assert(kd.every((e) => e.code && e.windowsVirtualKeyCode > 0), 'no keydown ever has an empty code / keyCode 0');
  const mir = kd.filter((e) => ['М', 'и', 'р'].includes(e.key));
  assert(mir.length === 3 && mir[0].code === 'KeyV' && mir[1].code === 'KeyB' && mir[2].code === 'KeyH' && mir[0].windowsVirtualKeyCode === 86, 'Cyrillic is typed on the physical keys of the layout (М=KeyV, и=KeyB, р=KeyH)');
  assert(mix.filter((e) => e.pw === 'down' && e.key === 'Alt').length === 2 && mix.filter((e) => e.pw === 'down' && e.key === 'Shift').length === 2, 'a human Alt+Shift chord before the Russian word and another after it');
  assert(mix.some((e) => e.pw === 'insertText' && e.text === '😀') && !kd.some((e) => e.key === '😀'), 'emoji go through insertText, never a keydown');
  const bang = kd.find((e) => e.key === '!');
  assert(bang && bang.code === 'Digit1' && (bang.modifiers & 8), "'!' on the Russian layout is Shift+Digit1 with an explicit Shift");

  // an explicitly held Shift is respected: never released by the typing engine
  const held = await typeMocked('abC', { rng: h.makeRng(2), typos: 'off' }, async (pg) => {
    const st = h.inputState(pg); st.modifiers = 8; st.keys.add('Shift');
  });
  const hk = downs(held);
  assert(hk.map((e) => e.key).join('') === 'ABC', 'with Shift held the keys yield their shifted characters (ABC)');
  assert(!held.some((e) => e.m === 'Input.dispatchKeyEvent' && e.type === 'keyUp' && e.code === 'ShiftLeft') && !hk.some((e) => e.code === 'ShiftLeft'), 'typing never presses or releases a Shift that it did not press itself');
  // transient Shift of its own is balanced
  const own = await typeMocked('aBc', { rng: h.makeRng(2), typos: 'off' });
  const sdown = own.filter((e) => e.m === 'Input.dispatchKeyEvent' && e.code === 'ShiftLeft');
  assert(sdown.filter((e) => e.type !== 'keyUp').length === sdown.filter((e) => e.type === 'keyUp').length && sdown.length === 2, 'its own transient Shift is pressed and released exactly once');
  // discrete events are stamped by Chrome when it receives them (like real input): no explicit timestamp from us, and the
  // dwell is REAL time between the two dispatches (the keyUp leaves exactly the drawn dwell after the keyDown)
  const keyEvents = own.filter((e) => e.m === 'Input.dispatchKeyEvent');
  assert(keyEvents.length > 0 && keyEvents.every((e) => e.timestamp === undefined), 'key events carry NO explicit timestamp (Chrome stamps them at dispatch)');
  const kA = own.filter((e) => e.m === 'Input.dispatchKeyEvent' && e.code === 'KeyA');
  const dwellA = kA[1].t - kA[0].t;
  assert(kA.length === 2 && dwellA >= 25 && dwellA <= 140, `the key dwell is the real time between keyDown and keyUp (${dwellA.toFixed(2)} ms, drawn from 25-140)`);
  // a held key: the keyUp leaves at exactly t0 + hold, autorepeats on a ~33 ms schedule after ~500 ms, none of it timestamped
  {
    const mp = mockPage();
    const r = await inVirtualTime(() => h.humanPress(mp.page, 'a', { rng: h.makeRng(4), hold: 1200 }));
    const ev = mp.events.filter((e) => e.m === 'Input.dispatchKeyEvent' && e.code === 'KeyA');
    const t0 = ev[0].t, up = ev[ev.length - 1];
    const reps = ev.filter((e) => e.autoRepeat);
    const gaps = reps.slice(1).map((e, i) => e.t - reps[i].t);
    assert(up.type === 'keyUp' && Math.abs(up.t - t0 - 1200) < 0.001, `a held key is released exactly --hold after it went down (${(up.t - t0).toFixed(3)} ms)`);
    assert(r.autoRepeats === reps.length && reps.length >= 14 && reps[0].t - t0 >= 380 && reps[0].t - t0 <= 650, `autorepeat starts after ~500 ms (${(reps[0].t - t0).toFixed(0)} ms) and keeps going (${reps.length} repeats)`);
    assert(gaps.length > 5 && gaps.every((g) => g >= 29 && g <= 37), 'autorepeats are ~33 ms apart (31-35 +-), in real time');
    assert(ev.every((e) => e.timestamp === undefined), 'and no timestamp is encoded in any of them');
  }

  // ---- real time: preciseSleep is accurate and does not ride the OS timer tick -----------------------------------------
  {
    const durations = [17, 23, 31, 46, 70];
    const runs = [];
    for (const d of durations) {
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        await timing.preciseSleep(d);
        runs.push({ d, ms: performance.now() - t0 });
      }
    }
    // a CI VM is noisier than a workstation: the same defects (a lattice, a sleep that is simply wrong) are still caught
    const tol = CI ? 6 : 2, need = CI ? 0.8 : 0.9;
    const accurate = runs.filter((x) => Math.abs(x.ms - x.d) < tol).length / runs.length;
    assert(accurate >= need, `preciseSleep(17/23/31/46/70) x 10: ${(accurate * 100).toFixed(0)}% within ${tol} ms of the request (need ${need * 100}%)`);
    assert(runs.every((x) => x.ms >= x.d - 0.05), 'a precise sleep never returns early');
    // Node's own timer lands on multiples of the OS tick (15.625 ms on Windows): ~100% within +-1 ms of the lattice. 31 and 46 sit
    // within 1 ms of a multiple BY CONSTRUCTION (2 x 15.625 = 31.25, 3 x 15.625 = 46.875), so a continuous sleep scores 0.4 here.
    const onLattice = runs.filter((x) => { const r = x.ms % 15.625; return Math.min(r, 15.625 - r) <= 1; }).length / runs.length;
    assert(onLattice < 0.5, `the sleeps are not quantised to the 15.625 ms timer lattice (share on the lattice ${onLattice.toFixed(2)}; a setTimeout sleep scores ~1)`);
    const gran = timing.granularity();
    assert(gran >= 1 && gran <= 25, `the timer granularity in force is sane (${gran} ms)`);
    // the estimator is the UPPER quartile of the setTimeout(1) gaps: a browser launching at the same moment wakes the loop between
    // ticks, so the median of the first gaps is short (two measured launches below: median 10.1 and 6.5 for a 15.5 ms tick)
    const launch1 = [1.8, 2.4, 1.6, 1.9, 11.4, 10.1, 15.5, 15.5, 15.5], launch2 = [0.3, 0.8, 6.5, 5.3, 0.0, 15.5, 15.5, 15.5, 15.5];
    const idleWin = Array.from({ length: 15 }, (_, i) => 15.45 + (i % 5) * 0.03), idleUnix = Array.from({ length: 15 }, (_, i) => 1.1 + (i % 4) * 0.05);
    assert(timing.granularityFromGaps(launch1) === 15.5 && timing.granularityFromGaps(launch2) === 15.5, 'the granularity estimate survives the short gaps of a browser launching (15.5, where the median says 10.1 / 6.5)');
    const gw = timing.granularityFromGaps(idleWin), gu = timing.granularityFromGaps(idleUnix);
    assert(gw >= 15.5 && gw <= 16 && gu >= 1 && gu <= 2, `an idle Windows loop (${gw} ms) and an idle Unix loop (${gu} ms) are estimated at their own tick, to the next half ms`);
    assert(timing.granularityFromGaps([...Array(14).fill(1.2), 60]) === 1.5 && timing.granularityFromGaps([100, 100, 100]) === 25 && timing.granularityFromGaps([0, 0]) === 1
      && timing.granularityFromGaps([], 7) === 7 && timing.granularityFromGaps([NaN, 3, 3, 3, 3], 7) === 3, 'one stalled gap does not move it; it stays within 1..25; no usable gap keeps the current value');
    const t1 = performance.now();
    await timing.coarseSleep(30);
    assert(performance.now() - t1 >= 25, 'coarseSleep still waits (a plain timer)');
  }

  // ---- the event clock: monotonic, anchored to the wall clock; pinClock pins Chrome's offset to it ----------------------
  {
    timing.reanchor();
    const first = timing.nowSec();
    assert(Math.abs(first - Date.now() / 1000) < 0.002, 'nowSec() is within 2 ms of the wall clock right after anchoring');
    let prev = first, monotonic = true;
    for (let i = 0; i < 3000; i++) { const t = timing.nowSec(); if (t < prev) monotonic = false; prev = t; }
    assert(monotonic, 'nowSec() never goes backwards');
    await timing.preciseSleep(40);
    const drift = Math.abs(timing.nowSec() - Date.now() / 1000);
    assert(drift < 0.005, `and keeps pace with the wall clock over a sleep (${(drift * 1000).toFixed(2)} ms apart)`);
    const sent = [];
    const stamp = await timing.pinClock({ send: async (m, p) => { sent.push([m, p]); } });
    assert(sent.length === 1 && sent[0][0] === 'Input.dispatchMouseEvent' && sent[0][1].type === 'mouseMoved' && sent[0][1].x === 0 && sent[0][1].y === 0
      && sent[0][1].button === 'none' && sent[0][1].timestamp === stamp && Math.abs(stamp - Date.now() / 1000) < 0.005,
    'pinClock re-anchors, then sends exactly ONE timestamped mouseMoved(0,0) with the anchored clock\'s time');
  }

  // ---- the device-pixel grid ---------------------------------------------------------------------------------------------
  {
    assert(h.q(100.37, 1) === 100 && h.q(100.37, 1.5).toFixed(3) === '100.667' && h.q(5, 2) === 5, 'q() snaps to round(v*dpr)/dpr: 100.37 -> 100 at dpr 1, 100.667 at dpr 1.5');
    assert(h.q(7.4) === 7 && h.q(7.6, undefined) === 8 && h.q(7.6, 0) === 8 && h.q(7.6, NaN) === 8, 'an unknown dpr counts as 1');
    const rngG = h.makeRng(33);
    let onGrid = true, idem = true, near = true;
    for (let i = 0; i < 5000; i++) {
      const v = rngG() * 2000 - 100, dpr = [1, 1.25, 1.5, 2, 2.5, 3][i % 6];
      const s = h.q(v, dpr);
      if (Math.abs(s * dpr - Math.round(s * dpr)) > 1e-6) onGrid = false;
      if (h.q(s, dpr) !== s) idem = false;
      if (Math.abs(s - v) > 0.5 / dpr + 1e-9) near = false;
    }
    assert(onGrid && idem && near, 'q() lands on a whole device pixel, is idempotent and moves a point by at most half a device pixel');

    // jitterPoint with a dpr: on the grid and still inside the bounds (a point that rounds to the far edge steps back a device pixel)
    const bounds = { x0: 0, y0: 0, x1: 100, y1: 60 };
    let ok = true;
    for (const dpr of [1, 1.5, 2]) {
      const rj = h.makeRng(7 + dpr);
      for (let i = 0; i < 4000; i++) {
        const p = h.jitterPoint({ x: rj() * 100, y: rj() * 60 }, rj, bounds, i % 3 === 0, dpr);
        if (Math.abs(p.x * dpr - Math.round(p.x * dpr)) > 1e-6 || Math.abs(p.y * dpr - Math.round(p.y * dpr)) > 1e-6) ok = false;
        if (p.x < bounds.x0 || p.x >= bounds.x1 || p.y < bounds.y0 || p.y >= bounds.y1) ok = false;
      }
    }
    assert(ok, 'a landing point with a dpr is on the device-pixel grid and inside the viewport/box');
    assert(JSON.stringify(h.jitterPoint({ x: 99.9, y: 59.9 }, h.makeRng(1), bounds, true, 1)) === '{"x":99,"y":59}', 'a point that rounds onto the far edge steps back one device pixel');

    // every coordinate the daemon dispatches while it moves, at dpr 1, 1.5 and 1.25 (CDP burst sub-samples AND Playwright moves)
    for (const dpr of [1, 1.5, 1.25]) {
      const mp = mockPage({ width: 800, height: 600, dpr });
      await inVirtualTime(async () => {
        await h.moveTo(mp.page, 333.37, 222.21, { rng: h.makeRng(11), targetW: 40 });
        await h.moveTo(mp.page, 640.6, 150.3, { rng: h.makeRng(12), targetW: 40 });      // a long move, maybe an overshoot
        await h.moveTo(mp.page, 640.9, 150.9, { rng: h.makeRng(13), targetW: 40 });      // within 2 px: the idle jitter path
        await h.syncPointer(mp.page);
      });
      const coordsSent = mp.events.filter((e) => e.m === 'Input.dispatchMouseEvent' || e.pw === 'move');
      const bad = coordsSent.filter((e) => Math.abs(e.x * dpr - Math.round(e.x * dpr)) > 1e-6 || Math.abs(e.y * dpr - Math.round(e.y * dpr)) > 1e-6);
      assert(coordsSent.length > 20 && bad.length === 0, `dpr ${dpr}: all ${coordsSent.length} dispatched pointer coordinates are on the device-pixel grid`);
      const pos = h.inputState(mp.page).pos;
      assert(Math.abs(pos.x * dpr - Math.round(pos.x * dpr)) < 1e-6 && pos.x === h.q(640.9, dpr) && pos.y === h.q(150.9, dpr), `dpr ${dpr}: the tracked pointer holds the snapped point (${pos.x}, ${pos.y})`);
    }

    // the coalesced sub-samples: stamps from the event clock, strictly increasing (also from one burst to the next), the last
    // of a burst = now and none later, no explicit timestamp anywhere else
    const mpb = mockPage({ width: 800, height: 600, dpr: 1 });
    await inVirtualTime(async () => {
      await h.moveTo(mpb.page, 600.4, 400.7, { rng: h.makeRng(21), targetW: 30 });
      await h.moveTo(mpb.page, 50.5, 70.5, { rng: h.makeRng(22), targetW: 30 });
    });
    const bursts = mpb.events.filter((e) => e.m === 'Input.dispatchMouseEvent' && e.type === 'mouseMoved');
    let increasing = true, notFuture = true, lastStamp = -Infinity, multi = 0;
    for (let i = 0; i < bursts.length; i++) {
      const e = bursts[i];
      if (!(e.timestamp > lastStamp)) increasing = false;
      if (e.timestamp > e.sentAtSec + 1e-9) notFuture = false;
      lastStamp = e.timestamp;
      if (i > 0 && bursts[i - 1].sentAtSec === e.sentAtSec) multi += 1;
    }
    assert(bursts.length > 30 && multi > 10, `coalesced bursts are dispatched (${bursts.length} sub-samples, ${multi} sharing a burst)`);
    assert(increasing, 'sub-sample timestamps are strictly increasing, across bursts too');
    assert(notFuture, 'no sub-sample is dated after the moment it is sent');
  }

  // fill / humanClearField: a field without the focus ALWAYS gets a click ("move only" is for a field that already has it:
  // otherwise select-all, the delete key and the text that follows hit the previously focused field - seen in 1 of 14 rounds);
  // the select-all and the delete key go through the key emitter (Cmd+A on macOS), not Playwright's keyboard.press
  {
    const field = (focused) => ({ waitFor: async () => {}, boundingBox: async () => ({ x: 20, y: 70, width: 360, height: 70 }), scrollIntoViewIfNeeded: async () => {}, evaluate: async () => focused });
    const clearRun = async (focused) => {
      const mp = mockPage({ width: 800, height: 600, dpr: 1 });
      await inVirtualTime(() => h.humanClearField(mp.page, field(focused), { rng: () => 0.95 }));      // rng 0.95: the "no click" branch of the gesture draw
      return mp.events;
    };
    const unfocused = await clearRun(false), focused = await clearRun(true);
    assert(unfocused.filter((e) => e.pw === 'mdown').length === 1 && unfocused.filter((e) => e.pw === 'mup').length === 1, 'a field that does not have the focus is clicked once, even when the gesture draw says "move only"');
    assert(focused.filter((e) => e.pw === 'mdown').length === 0, 'a field that already has the focus is not clicked in the "move only" case');
    for (const [label, evs] of [['unfocused', unfocused], ['focused', focused]]) {
      const mac = process.platform === 'darwin';
      const selectAll = mac ? evs.some((e) => e.pw === 'down' && e.key === 'Meta') && evs.some((e) => e.pw === 'down' && e.key === 'a')
        : evs.some((e) => e.m === 'Input.dispatchKeyEvent' && e.code === 'KeyA' && e.type !== 'keyUp' && (e.modifiers & 2));
      const del = evs.some((e) => e.m === 'Input.dispatchKeyEvent' && (e.code === 'Backspace' || e.code === 'Delete') && e.type !== 'keyUp');
      assert(selectAll && del && !evs.some((e) => e.pw === 'press'), `${label}: ${mac ? 'Cmd+A' : 'Ctrl+A'} and a delete key through the key emitter, never Playwright's keyboard.press`);
    }
  }

  // a click never lands in the resize grip of a textarea (a press there starts a resize drag and the field never gets the focus:
  // measured, ~1 click in 80 on a wide textarea - the Gaussian pick is clamped to a margin, which piles mass onto the edge)
  {
    const box = { x: 20, y: 70, width: 366, height: 76 };           // keys.html's #ta border box
    const loc = (resizable) => ({ evaluate: async () => resizable });
    const corner = { x: 380, y: 133 };                               // the point that failed on the bundled Chromium
    assert(h.inResizeGrip(box, corner) && !h.inResizeGrip(box, { x: 200, y: 108 }) && !h.inResizeGrip(box, { x: 380, y: 100 }) && !h.inResizeGrip(box, { x: 300, y: 140 }), 'the grip is the bottom-right 18 px corner of the box');
    const kept = await h.avoidResizeGrip(loc(false), box, corner, h.makeRng(1), 1000);
    assert(kept.x === 380 && kept.y === 133, 'on an element that cannot be resized a corner point stays (a button has no grip)');
    let moved = true;
    for (let i = 0; i < 200; i++) {
      const p = await h.avoidResizeGrip(loc(true), box, corner, h.makeRng(i), 1000);
      if (h.inResizeGrip(box, p) || p.x < box.x || p.x > box.x + box.width || p.y < box.y || p.y > box.y + box.height) moved = false;
    }
    assert(moved, 'on a resizable one the point is moved out of the grip and stays inside the box (200 seeds)');
    const rr = h.makeRng(99); let hits = 0; const picks = 20000;
    for (let i = 0; i < picks; i++) if (h.inResizeGrip(box, h.pointInBox(box, rr))) hits += 1;
    assert(hits / picks > 0.003 && hits / picks < 0.05, `pointInBox alone lands in the grip of a 366x76 textarea in ${(100 * hits / picks).toFixed(2)}% of the picks: the reason for the guard`);
  }

  // the install pointer belongs to the INSTALLED package
  {
    const cfgMod = require('./config');
    const fsx = require('fs'), osx = require('os'), px = require('path');
    const root = fsx.mkdtempSync(px.join(osx.tmpdir(), 'nw-sanity-install-'));
    try {
      const mk = (...parts) => { const f = px.join(root, ...parts); fsx.mkdirSync(px.dirname(f), { recursive: true }); fsx.writeFileSync(f, '// script'); return f; };
      const installed = mk('global', 'node_modules', 'nativewright', 'src', 'browser.js');
      const checkout = mk('clone', 'src', 'browser.js');
      const lookalike = mk('clone2', 'my_node_modules_x', 'src', 'browser.js');
      assert(cfgMod.isInstalledScript(installed) === true && cfgMod.isInstalledScript(checkout) === false && cfgMod.isInstalledScript(lookalike) === false,
        'a script is an installed package only when its real path has a node_modules SEGMENT (a checkout, npm link and look-alike names are not)');
      assert(cfgMod.isInstalledScript(px.join(root, 'missing', 'node_modules', 'x', 'browser.js')) === true, 'and a path that does not exist is judged by its text');
    } finally { fsx.rmSync(root, { recursive: true, force: true }); }
  }

  // calibrate-wheel draws an overlay the site's own scripts can see: only blank / local pages qualify
  {
    const { _calibratablePage: ok } = require('./commands');
    const yes = ['about:blank', 'data:text/html,<p>x</p>', 'file:///C:/work/page.html', 'http://localhost:3000/a?b=1', 'https://localhost/', 'http://127.0.0.1:8080/', 'http://[::1]:9000/x'];
    const no = ['https://example.com/', 'http://127.0.0.2:8080/', 'http://localhost.evil.test/', 'http://127.0.0.1.evil.test/', 'http://192.168.1.5/', 'chrome://settings/', 'about:srcdoc', 'view-source:https://example.com/', '', 'not a url'];
    assert(yes.every((u) => ok(u)), 'calibrate-wheel is allowed on about:blank, data:, file: and http(s) on localhost / 127.0.0.1 / [::1]');
    assert(no.every((u) => !ok(u)), 'and refused everywhere else (a website, another loopback address, a look-alike host, chrome:// pages)');
  }

  // the paste decision paths against a mocked clipboard backend + page (nothing real is touched)
  {
    const pasteMod = require('./paste');
    const cb = require('./clipboard');
    const saved = { detect: cb.detectBackend, lock: cb.acquireLock };
    const run = async (backendOver, lockOver, pasteOpts = {}, text = 'hello world') => {
      const calls = [];
      const opts = [];                                    // the options every in-lock call was made with
      const backend = {
        warm: async () => { calls.push('warm'); },
        snapshot: async (o) => { calls.push('snapshot'); opts.push(o); return { kind: 'text', formats: ['UnicodeText'], text: 'orig' }; },
        write: async (t, o) => { calls.push('write'); opts.push(o); },
        restoreIfOurs: async (s, p, o) => { calls.push('restore'); opts.push(o); return { restored: true }; },
        ...(typeof backendOver === 'function' ? backendOver(calls) : backendOver),
      };
      cb.detectBackend = async () => ({ backend });
      cb.acquireLock = lockOver || (async () => { calls.push('lock'); return { waitedMs: 7, release: async () => { calls.push('unlock'); } }; });
      const mp = mockPage();
      mp.page.mainFrame = () => ({ evaluateHandle: async () => { throw new Error('no dom in this mock'); } });
      const ctx = { page: mp.page, rec: { id: 'p1' }, session: { isHeadless: () => !!pasteOpts.headless } };
      const r = await inVirtualTime(() => pasteMod.pasteFocused(ctx, text, { rng: h.makeRng(5), typos: 'off', ...pasteOpts }));
      return { r, calls, opts, events: mp.events };
    };
    try {
      const locked = await run((calls) => ({
        write: async () => { calls.push('write'); throw new Error('clipboard is open in another application'); },
        // as the real backend answers when our payload never arrived
        restoreIfOurs: async () => { calls.push('restore'); return { restored: false, reason: 'clipboard changed meanwhile; left as is' }; },
      }));
      assert(locked.r.method === 'typed' && locked.r.reason === 'clipboard-unwritable' && /another application/.test(locked.r.detail), 'a locked clipboard (write fails) falls back to typing instead of failing the command');
      assert(locked.r.clipboardTouched === false && locked.r.clipboardRestored === true, 'and reports the clipboard as untouched');
      assert(locked.calls.join() === 'warm,lock,snapshot,write,restore,unlock', `the helper is warmed BEFORE the lock; the lock is always released, restore only conditional on our payload (${locked.calls.join()})`);
      assert(downs(locked.events).length >= 'hello world'.replace(/ /g, '').length, 'the text was typed with key events');

      const other = await run({ snapshot: async () => ({ kind: 'other', formats: ['UnicodeText', 'HTML Format'], text: null }) });
      assert(other.r.method === 'typed' && other.r.reason === 'non-text clipboard' && other.r.clipboardTouched === false, 'a non-text clipboard is never written: typed');
      assert(other.calls.join() === 'warm,lock,unlock', `no write, no restore for a non-text clipboard (${other.calls.join()})`);

      const busy = await run({}, async () => { const e = new Error('clipboard busy'); e.code = 'CLIPBOARD_BUSY'; e.waitedMs = 10000; throw e; });
      assert(busy.r.method === 'typed' && busy.r.reason === 'clipboard-busy' && busy.r.lockWaitMs === 10000 && busy.calls.join() === 'warm', 'a lock that stays busy for 10 s falls back to typing without touching the clipboard');

      // the helper cannot be started: typed, 'clipboard-unreadable' with a clear detail, and the lock is never taken
      const cold = await run({ warm: async () => { throw new Error('clipboard helper did not start within 20000 ms'); } });
      assert(cold.r.method === 'typed' && cold.r.reason === 'clipboard-unreadable' && /could not be started: .*did not start within 20000 ms/.test(cold.r.detail), 'a helper that cannot be started falls back to typing (clipboard-unreadable, with a detail)');
      assert(cold.calls.length === 0 && cold.r.clipboardTouched === false && cold.r.clipboardRestored === true, 'and neither takes the lock nor touches the clipboard');

      // every call made inside the lock is short-bounded (the helper start has its own bound, before the lock)
      const normal = await run({});
      assert(normal.calls.join() === 'warm,lock,snapshot,write,restore,unlock' && normal.opts.length === 3 && normal.opts.every((o) => o && o.timeoutMs === 10000), `snapshot, write and restore get a 10 s timeout (${JSON.stringify(normal.opts)})`);

      // no helper request may outlive the lock. A write that never answers: the helper is killed BEFORE the restore, the
      // restore goes through a fresh one, and the report does not claim a clean clipboard
      const hungWrite = await run((calls) => {
        let owed = false;
        return {
          write: async () => { calls.push('write'); owed = true; throw Object.assign(new Error('clipboard helper timed out (write)'), { uncertain: true }); },
          hasUnanswered: () => owed,
          kill: async () => { calls.push('kill'); owed = false; },
          restoreIfOurs: async () => { calls.push('restore'); return { restored: false, reason: 'clipboard changed meanwhile; left as is' }; },
        };
      });
      assert(hungWrite.calls.join() === 'warm,lock,snapshot,write,kill,restore,unlock', `a hung write: the helper is killed before the restore and before the unlock (${hungWrite.calls.join()})`);
      assert(hungWrite.r.method === 'typed' && hungWrite.r.reason === 'clipboard-unwritable' && /timed out/.test(hungWrite.r.detail), 'and the text is typed instead');
      assert(hungWrite.r.clipboardRestored === false && /helper was stopped/.test(hungWrite.r.restoreNote || ''), 'the report is honest: the clipboard could not be confirmed unchanged');
      const hungThenRestored = await run((calls) => {
        let owed = false;
        return {
          write: async () => { calls.push('write'); owed = true; throw Object.assign(new Error('clipboard helper timed out (write)'), { uncertain: true }); },
          hasUnanswered: () => owed, kill: async () => { calls.push('kill'); owed = false; },
          restoreIfOurs: async () => { calls.push('restore'); return { restored: true }; },   // the late payload had landed: the fresh helper put the original back
        };
      });
      assert(hungThenRestored.r.clipboardTouched === true && hungThenRestored.r.clipboardRestored === true && !hungThenRestored.r.restoreNote, 'if the payload had landed after all, the restore through the fresh helper is reported as such');
      // a snapshot that never answers: nothing was written, the helper is still killed before the unlock
      const hungSnap = await run((calls) => {
        let owed = false;
        return {
          snapshot: async () => { calls.push('snapshot'); owed = true; throw Object.assign(new Error('clipboard helper timed out (snapshot)'), { uncertain: true }); },
          hasUnanswered: () => owed, kill: async () => { calls.push('kill'); owed = false; },
        };
      });
      assert(hungSnap.calls.join() === 'warm,lock,snapshot,kill,unlock' && hungSnap.r.reason === 'clipboard-unreadable' && hungSnap.r.clipboardTouched === false && hungSnap.r.clipboardRestored === true, `a hung snapshot: killed before the unlock, no write, no restore (${hungSnap.calls.join()})`);
      // a restore that never answers: killed before the unlock, reported as not restored
      const hungRestore = await run((calls) => {
        let owed = false;
        return {
          restoreIfOurs: async () => { calls.push('restore'); owed = true; return { restored: false, failed: true, reason: 'restore failed: clipboard helper timed out (restore)' }; },
          hasUnanswered: () => owed, kill: async () => { calls.push('kill'); owed = false; },
        };
      });
      assert(hungRestore.calls.join() === 'warm,lock,snapshot,write,restore,kill,unlock' && hungRestore.r.clipboardRestored === false && /timed out \(restore\)/.test(hungRestore.r.restoreNote || ''), `a hung restore: killed before the unlock, reported (${hungRestore.calls.join()})`);
      // the lock is released even if the restore throws (the exception still propagates)
      let boomCalls = null, threw = null;
      try { await run((calls) => { boomCalls = calls; return { restoreIfOurs: async () => { calls.push('restore'); throw new Error('restore blew up'); } }; }); } catch (e) { threw = e; }
      assert(threw && /restore blew up/.test(threw.message) && boomCalls.join() === 'warm,lock,snapshot,write,restore,unlock', `an exception in the restore still propagates, and the lock is released (${boomCalls && boomCalls.join()})`);

      const head = await (async () => {
        cb.detectBackend = async () => { throw new Error('must not be asked in headless'); };
        const mp = mockPage(); mp.page.mainFrame = () => ({ evaluateHandle: async () => { throw new Error('x'); } });
        return inVirtualTime(() => pasteMod.pasteFocused({ page: mp.page, rec: { id: 'p1' }, session: { isHeadless: () => true } }, 'abc', { rng: h.makeRng(1), typos: 'off' }));
      })();
      assert(head.method === 'typed' && head.reason === 'headless' && head.clipboardTouched === false, 'headless never looks at the OS clipboard');

      // A typed fallback never types an unbounded text (headless, or a busy clipboard + --from-file up to 5 MB, would type for
      // hours while the page's queue is blocked): past 2000 characters it REFUSES, naming the reason and what typing would cost.
      assert(pasteMod.MAX_TYPED_FALLBACK_CHARS === 2000, 'a typed fallback is allowed up to 2000 characters');
      const headlessCtx = (mp) => ({ page: mp.page, rec: { id: 'p1' }, session: { isHeadless: () => true } });
      const mpOver = mockPage(); mpOver.page.mainFrame = () => ({ evaluateHandle: async () => { throw new Error('x'); } });
      let refusal = null;
      try { await inVirtualTime(() => pasteMod.pasteFocused(headlessCtx(mpOver), 'x'.repeat(2001), { rng: h.makeRng(1), typos: 'off' })); } catch (e) { refusal = e; }
      assert(refusal && /reason 'headless'/.test(refusal.message) && /2001 characters/.test(refusal.message) && /about \d+ minutes?/.test(refusal.message)
        && /headed daemon/.test(refusal.message) && /plain-text clipboard/.test(refusal.message) && /fill --raw/.test(refusal.message),
      `2001 characters in headless: refused with the reason, the time it would take and what to do instead (${refusal && refusal.message.slice(0, 90)}...)`);
      assert(mpOver.events.length === 0, 'and nothing was typed');
      const mpAt = mockPage(); mpAt.page.mainFrame = () => ({ evaluateHandle: async () => { throw new Error('x'); } });
      const atLimit = await inVirtualTime(() => pasteMod.pasteFocused(headlessCtx(mpAt), 'x'.repeat(2000), { rng: h.makeRng(1), typos: 'off' }));
      assert(atLimit.method === 'typed' && atLimit.reason === 'headless' && mpAt.events.filter((e) => e.m === 'Input.dispatchKeyEvent' && e.type === 'keyUp').length === 2000, '2000 characters are typed');
      let busyRefusal = null, busyCalls = null;
      try {
        await run((calls) => { busyCalls = calls; return {}; }, async () => { const e = new Error('clipboard busy'); e.code = 'CLIPBOARD_BUSY'; e.waitedMs = 10000; throw e; }, {}, 'y'.repeat(2500));
      } catch (e) { busyRefusal = e; }
      assert(busyRefusal && /reason 'clipboard-busy'/.test(busyRefusal.message) && /2500 characters/.test(busyRefusal.message), 'any other fallback refuses a long text as well (a busy lock, 2500 characters)');
      assert(busyCalls && busyCalls.join() === 'warm', 'and the clipboard was not touched');
      const small = await run({}, undefined, { maxTypedChars: 30, headless: true }, 'z'.repeat(30));
      let smallRefusal = null;
      try { await run({}, undefined, { maxTypedChars: 30, headless: true }, 'z'.repeat(31)); } catch (e) { smallRefusal = e; }
      assert(small.r.method === 'typed' && smallRefusal && /more than the 30 a typed fallback is allowed/.test(smallRefusal.message), 'the limit is a strict "longer than": 30 typed, 31 refused (with the test option maxTypedChars: 30)');
    } finally { cb.detectBackend = saved.detect; cb.acquireLock = saved.lock; }
  }

  // The pace behind that "about N minutes": estimateTypingMs against humanType's own model (virtual time, ordinary English with
  // digits, capitals and punctuation, typos on), so the constant cannot drift away from the engine unnoticed.
  {
    const para = 'Typing speed varies a lot between people, and even for one person it changes with the text: familiar words come out in quick bursts, ' +
      'while numbers like 2026, names such as Alexandra Petrova, and punctuation (commas, colons; semicolons!) slow everyone down. A sentence ends. ' +
      'Another one begins, and the pace changes again. "Quoted text" and parentheses need the Shift key too. ';
    const sample = para.repeat(3);
    const mpT = mockPage();
    let elapsed = 0;
    await inVirtualTime(async () => { const s = timing.now(); await h.humanType(mpT.page, sample, { rng: h.makeRng(8), typos: 'on' }); elapsed = timing.now() - s; });
    const est = h.estimateTypingMs(sample);
    assert(Math.abs(est - elapsed) / elapsed < 0.2, `estimateTypingMs (${(est / 1000).toFixed(0)} s) is within 20% of what humanType really takes (${(elapsed / 1000).toFixed(0)} s virtual) for ${h.splitGraphemes(sample).length} characters`);
  }

  // input modality must match the fingerprint (mouse commands are refused when the page reports no fine pointer)
  {
    const modality = require('./modality');
    const pageWith = (profile) => ({ evaluate: async () => { if (profile instanceof Error) throw profile; return profile; } });
    const touchOnly = { anyFine: false, anyCoarse: true, anyHover: false, maxTouchPoints: 10 };
    const desktop = { anyFine: true, anyCoarse: false, anyHover: true, maxTouchPoints: 0 };
    await modality.assertMouseCapable(pageWith(desktop), 'click');
    assert(true, 'a page with a fine pointer may receive mouse input');
    let refusal = null;
    try { await modality.assertMouseCapable(pageWith(touchOnly), 'dblclick'); } catch (e) { refusal = e; }
    assert(refusal && /mouse input refused/.test(refusal.message) && /`dblclick`/.test(refusal.message), 'a touch-only page (any-pointer: fine is false) refuses mouse input, naming the command');
    assert(/tap/.test(refusal.message) && /swipe/.test(refusal.message) && /type-focused/.test(refusal.message) && /drop-files/.test(refusal.message), 'the refusal names the commands that DO work there');
    assert(/maxTouchPoints=10/.test(refusal.message) && /any-hover=false/.test(refusal.message), 'the refusal reports the measured media values');
    assert(await modality.hasFinePointer(pageWith(touchOnly)) === false && await modality.hasFinePointer(pageWith(desktop)) === true, 'hasFinePointer follows (any-pointer: fine)');
    await modality.assertMouseCapable(pageWith(new Error('navigating')), 'click');
    assert(await modality.hasFinePointer(pageWith(new Error('navigating'))) === true, 'if the page cannot be asked (mid-navigation) the gate fails open; the command itself reports the real problem');
  }

  console.log('\nALL SANITY CHECKS PASSED');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
