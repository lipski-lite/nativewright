'use strict';

/**
 * Keyboard vocabulary shared by `press`, `key-down`, `key-up` and the typing
 * engine: named keys, modifier names/aliases, combo splitting.
 *
 * Every key is described by the PHYSICAL key (`code` + Windows virtual key
 * code) plus the `key`/`text` it produces, because that is what real hardware
 * reports; character keys live in ./layouts.js (one map per keyboard layout).
 *
 * @module keys
 */

/** CDP / Playwright modifier bitmask. */
const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MOD_NAMES = ['Alt', 'Control', 'Meta', 'Shift'];

/** Mask of the modifiers that turn a keystroke into a shortcut (no text is inserted). */
const SHORTCUT_MASK = MOD_BITS.Alt | MOD_BITS.Control | MOD_BITS.Meta;

function maskOf(names) {
  let m = 0;
  for (const n of names) m |= MOD_BITS[n] || 0;
  return m;
}

// ---- named keys ------------------------------------------------------------
// vk = windowsVirtualKeyCode (the code WITHOUT left/right location, which is
// what DOM `keyCode` reports). `text` only for keys that insert text.
const NAMED = {
  Enter:     { code: 'Enter',     vk: 13,  key: 'Enter', text: '\r' },
  Tab:       { code: 'Tab',       vk: 9,   key: 'Tab' },
  Escape:    { code: 'Escape',    vk: 27,  key: 'Escape' },
  Backspace: { code: 'Backspace', vk: 8,   key: 'Backspace' },
  Delete:    { code: 'Delete',    vk: 46,  key: 'Delete' },
  Insert:    { code: 'Insert',    vk: 45,  key: 'Insert' },
  Home:      { code: 'Home',      vk: 36,  key: 'Home' },
  End:       { code: 'End',       vk: 35,  key: 'End' },
  PageUp:    { code: 'PageUp',    vk: 33,  key: 'PageUp' },
  PageDown:  { code: 'PageDown',  vk: 34,  key: 'PageDown' },
  ArrowUp:   { code: 'ArrowUp',   vk: 38,  key: 'ArrowUp' },
  ArrowDown: { code: 'ArrowDown', vk: 40,  key: 'ArrowDown' },
  ArrowLeft: { code: 'ArrowLeft', vk: 37,  key: 'ArrowLeft' },
  ArrowRight:{ code: 'ArrowRight',vk: 39,  key: 'ArrowRight' },
  Space:     { code: 'Space',     vk: 32,  key: ' ', text: ' ' },
  // modifiers: left-hand variants (what `Shift`, `Control`... mean everywhere)
  Shift:     { code: 'ShiftLeft',   vk: 16, key: 'Shift',   location: 1, modifier: 'Shift' },
  Control:   { code: 'ControlLeft', vk: 17, key: 'Control', location: 1, modifier: 'Control' },
  Alt:       { code: 'AltLeft',     vk: 18, key: 'Alt',     location: 1, modifier: 'Alt' },
  Meta:      { code: 'MetaLeft',    vk: 91, key: 'Meta',    location: 1, modifier: 'Meta' },
};
for (let i = 1; i <= 12; i++) NAMED['F' + i] = { code: 'F' + i, vk: 111 + i, key: 'F' + i };
for (const [name, d] of Object.entries(NAMED)) d.name = name;

// lower-case alias -> canonical name
const ALIASES = {
  ctrl: 'Control', control: 'Control', controlleft: 'Control',
  cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', windows: 'Meta', super: 'Meta', metaleft: 'Meta',
  alt: 'Alt', option: 'Alt', opt: 'Alt', altleft: 'Alt',
  shift: 'Shift', shiftleft: 'Shift',
  enter: 'Enter', return: 'Enter',
  tab: 'Tab',
  esc: 'Escape', escape: 'Escape',
  backspace: 'Backspace', bksp: 'Backspace',
  delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End',
  pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown', pgdown: 'PageDown',
  arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
  arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
  space: 'Space', spacebar: 'Space',
};
for (let i = 1; i <= 12; i++) ALIASES['f' + i] = 'F' + i;

/** Canonical modifier name for `ControlOrMeta`-style / alias spellings, else null. */
function canonicalModifier(name) {
  const s = String(name).trim();
  if (/^controlormeta$/i.test(s)) return process.platform === 'darwin' ? 'Meta' : 'Control';
  const c = ALIASES[s.toLowerCase()];
  return c && NAMED[c].modifier ? c : null;
}

/**
 * Parse `--modifiers=Control,Shift` (comma/plus separated, case-insensitive,
 * Ctrl/Cmd/Win/Option aliases). Returns canonical names in a stable order.
 * @returns {{names: string[], mask: number}}
 */
function parseModifierList(value) {
  if (value == null || value === true || value === '') return { names: [], mask: 0 };
  const parts = String(value).split(/[,+\s]+/).filter(Boolean);
  const names = [];
  for (const p of parts) {
    const m = canonicalModifier(p);
    if (!m) throw new Error(`unknown modifier '${p}' (use Control, Shift, Alt, Meta; aliases Ctrl, Cmd, Win, Option)`);
    if (!names.includes(m)) names.push(m);
  }
  return { names, mask: maskOf(names) };
}

/**
 * Split a combo like "Control+Shift+ArrowLeft" into tokens. Same algorithm as
 * Playwright's keyboard.press, so "Control++" means Control and "+".
 */
function splitCombo(str) {
  const keys = [];
  let building = '';
  for (const ch of String(str)) {
    if (ch === '+' && building) { keys.push(building); building = ''; }
    else building += ch;
  }
  keys.push(building);
  return keys;
}

/** Named-key descriptor for a token (aliases, case-insensitive), or null. */
function namedKey(token) {
  const t = String(token);
  if (NAMED[t]) return NAMED[t];
  const mod = canonicalModifier(t);
  if (mod) return NAMED[mod];
  const c = ALIASES[t.toLowerCase()];
  return c ? NAMED[c] : null;
}

module.exports = {
  MOD_BITS, MOD_NAMES, SHORTCUT_MASK, NAMED, ALIASES,
  maskOf, canonicalModifier, parseModifierList, splitCombo, namedKey,
};
