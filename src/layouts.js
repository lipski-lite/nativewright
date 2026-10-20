'use strict';

/**
 * Keyboard layouts, keyed on the PHYSICAL key.
 *
 * Real hardware reports the position of the key (`code`, plus the Windows
 * virtual-key code of that position) independently of the character the active
 * layout turns it into (`key`). So Cyrillic text is typed with the same
 * `code`s and key codes as Latin text, only `key`/`text` differ. A layout maps
 * characters to { code, vk, key, text, shift }, where `shift` says whether the
 * character needs Shift on that layout.
 *
 * Two layouts are modelled: US English ('en') and Russian ЙЦУКЕН ('ru'). The
 * input engine tracks the active layout per page and, when the next character
 * is only typable on the other layout, performs a human layout-switch chord
 * (Alt+Shift by default, Ctrl+Shift via NATIVEWRIGHT_LAYOUT_SWITCH) first.
 *
 * @module layouts
 */

function makeLayout(name) {
  return { name, byChar: Object.create(null), byCode: Object.create(null) };
}

function add(layout, ch, code, vk, shift) {
  const desc = { code, vk, key: ch, text: ch, shift: !!shift, layout: layout.name };
  layout.byChar[ch] = desc;
  const slot = layout.byCode[code] || (layout.byCode[code] = { base: null, shifted: null });
  if (shift) slot.shifted = desc; else slot.base = desc;
  return desc;
}

// ---------------------------------------------------------------------------
// US English
// ---------------------------------------------------------------------------

function buildEN() {
  const L = makeLayout('en');
  for (let i = 0; i < 26; i++) {
    const lo = String.fromCharCode(97 + i), up = String.fromCharCode(65 + i);
    add(L, lo, 'Key' + up, 65 + i, false);
    add(L, up, 'Key' + up, 65 + i, true);
  }
  const sh = ')!@#$%^&*(';
  for (let d = 0; d < 10; d++) {
    add(L, String(d), 'Digit' + d, 48 + d, false);
    add(L, sh[d], 'Digit' + d, 48 + d, true);
  }
  add(L, ' ', 'Space', 32, false);
  const punct = [
    ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
    ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
    [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
    ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
  ];
  for (const [lo, hi, code, vk] of punct) { add(L, lo, code, vk, false); add(L, hi, code, vk, true); }
  return L;
}

// ---------------------------------------------------------------------------
// Russian ЙЦУКЕН (Windows "Russian" layout), keyed on physical codes
// ---------------------------------------------------------------------------

// [lowercase, code, vk]; the uppercase letter is Shift + the same physical key.
const RU_LETTERS = [
  ['й', 'KeyQ', 81], ['ц', 'KeyW', 87], ['у', 'KeyE', 69], ['к', 'KeyR', 82], ['е', 'KeyT', 84],
  ['н', 'KeyY', 89], ['г', 'KeyU', 85], ['ш', 'KeyI', 73], ['щ', 'KeyO', 79], ['з', 'KeyP', 80],
  ['х', 'BracketLeft', 219], ['ъ', 'BracketRight', 221],
  ['ф', 'KeyA', 65], ['ы', 'KeyS', 83], ['в', 'KeyD', 68], ['а', 'KeyF', 70], ['п', 'KeyG', 71],
  ['р', 'KeyH', 72], ['о', 'KeyJ', 74], ['л', 'KeyK', 75], ['д', 'KeyL', 76],
  ['ж', 'Semicolon', 186], ['э', 'Quote', 222],
  ['я', 'KeyZ', 90], ['ч', 'KeyX', 88], ['с', 'KeyC', 67], ['м', 'KeyV', 86], ['и', 'KeyB', 66],
  ['т', 'KeyN', 78], ['ь', 'KeyM', 77], ['б', 'Comma', 188], ['ю', 'Period', 190],
  ['ё', 'Backquote', 192],
];

function buildRU() {
  const L = makeLayout('ru');
  for (const [lo, code, vk] of RU_LETTERS) {
    add(L, lo, code, vk, false);
    add(L, lo.toUpperCase(), code, vk, true);
  }
  for (let d = 0; d <= 9; d++) add(L, String(d), 'Digit' + d, 48 + d, false);
  add(L, ' ', 'Space', 32, false);
  // Shifted digit row on the Russian layout
  add(L, '!', 'Digit1', 49, true);
  add(L, '"', 'Digit2', 50, true);
  add(L, '№', 'Digit3', 51, true);
  add(L, ';', 'Digit4', 52, true);
  add(L, '%', 'Digit5', 53, true);
  add(L, ':', 'Digit6', 54, true);
  add(L, '?', 'Digit7', 55, true);
  add(L, '*', 'Digit8', 56, true);
  add(L, '(', 'Digit9', 57, true);
  add(L, ')', 'Digit0', 48, true);
  // Punctuation positions that differ from / match US
  add(L, '-', 'Minus', 189, false);  add(L, '_', 'Minus', 189, true);
  add(L, '=', 'Equal', 187, false);  add(L, '+', 'Equal', 187, true);
  add(L, '\\', 'Backslash', 220, false); add(L, '/', 'Backslash', 220, true);
  add(L, '.', 'Slash', 191, false);  add(L, ',', 'Slash', 191, true);
  return L;
}

const LAYOUTS = { en: buildEN(), ru: buildRU() };
const LAYOUT_NAMES = Object.keys(LAYOUTS);

/** The US-English map, which is also what the old KEYMAP export was. */
const EN = LAYOUTS.en;

/**
 * Resolve a character against the active layout.
 *  - typable on the active layout          -> { desc, layout: active, switchTo: null }
 *  - typable only on another layout        -> { desc, layout: other,  switchTo: other }
 *  - typable on none (emoji, CJK, ...)     -> null  (caller uses Input.insertText)
 * A character typable on BOTH layouts always uses the active layout's key.
 */
function resolveChar(ch, active = 'en') {
  const cur = LAYOUTS[active] || EN;
  if (cur.byChar[ch]) return { desc: cur.byChar[ch], layout: cur.name, switchTo: null };
  for (const name of LAYOUT_NAMES) {
    if (name !== cur.name && LAYOUTS[name].byChar[ch]) {
      return { desc: LAYOUTS[name].byChar[ch], layout: name, switchTo: name };
    }
  }
  return null;
}

/** The shifted variant of a key (what the same physical key gives while Shift is held). */
function withShiftHeld(desc) {
  if (!desc || desc.shift) return desc;
  const slot = (LAYOUTS[desc.layout] || EN).byCode[desc.code];
  return slot && slot.shifted ? slot.shifted : desc;
}

/** Look a physical-code token ("KeyA", "Digit1", "Backquote") up on a layout. */
function byCodeToken(code, active = 'en') {
  const slot = (LAYOUTS[active] || EN).byCode[code];
  return slot && slot.base ? slot.base : null;
}

// ---------------------------------------------------------------------------
// Typos: the finger lands on a PHYSICALLY adjacent key
// ---------------------------------------------------------------------------

// Adjacent keys on a QWERTY board (letters + the space bar's neighbours).
const NEIGHBOR_KEY = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'rygf',
  y: 'tuhg', u: 'yijh', i: 'uojk', o: 'ipkl', p: 'ol',
  a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv',
  h: 'gyujnb', j: 'huiknm', k: 'jiolm', l: 'kop', z: 'asx',
  x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  ' ': 'bnvcxm',
};

/**
 * A plausible mistyped neighbour of `ch` on the given layout, or null when the
 * key has no mapped neighbours. Neighbours are derived from the QWERTY map
 * through the PHYSICAL code, so Russian typos are the Russian letters on the
 * keys next to the intended one. Consumes exactly one rng() when it returns
 * a character (and none otherwise), like the original English-only version.
 */
function typoFor(ch, rng, active = 'en') {
  if (active === 'en') {
    const lower = ch.toLowerCase();
    const nbrs = NEIGHBOR_KEY[lower];
    if (!nbrs) return null;
    const wrong = nbrs[Math.floor(rng() * nbrs.length)];
    return ch === ch.toUpperCase() && ch !== lower ? wrong.toUpperCase() : wrong;
  }
  const lay = LAYOUTS[active];
  const d = lay && lay.byChar[ch];
  if (!d) return null;
  const enSlot = EN.byCode[d.code];
  const enKey = enSlot && enSlot.base ? enSlot.base.key : null;      // the Latin letter on that physical key
  const nbrs = enKey && NEIGHBOR_KEY[enKey];
  if (!nbrs) return null;
  const wrongEn = nbrs[Math.floor(rng() * nbrs.length)];
  const slot = lay.byCode[EN.byChar[wrongEn].code];
  if (!slot || !slot.base) return null;
  return d.shift && slot.shifted ? slot.shifted.key : slot.base.key;
}

// ---------------------------------------------------------------------------
// Layout switching chord
// ---------------------------------------------------------------------------

/** Modifiers of the layout-switch shortcut (default Alt+Shift). */
function switchChord() {
  const v = String(process.env.NATIVEWRIGHT_LAYOUT_SWITCH || process.env.PATCHRIGHT_LAYOUT_SWITCH || 'alt+shift').toLowerCase().trim();
  if (v === 'alt+shift') return ['Alt', 'Shift'];
  if (v === 'ctrl+shift' || v === 'control+shift') return ['Control', 'Shift'];
  throw new Error(`NATIVEWRIGHT_LAYOUT_SWITCH must be 'alt+shift' or 'ctrl+shift' (got '${v}')`);
}

module.exports = {
  LAYOUTS, LAYOUT_NAMES, EN, RU_LETTERS, NEIGHBOR_KEY,
  resolveChar, withShiftHeld, byCodeToken, typoFor, switchChord,
};
