'use strict';

/**
 * Input modality must match the fingerprint — the mirror image of the touch
 * gate in ./touch.js.
 *
 * touch.js refuses to send touch events from a browser that reports no touch
 * support (maxTouchPoints 0). The converse is just as contradictory: a browser
 * profile that says it has NO fine pointing device — Chrome's touch emulation
 * (NATIVEWRIGHT_TOUCH=1) produces a touch-only, tablet-class device:
 * (any-pointer: fine) false, (any-pointer: coarse) true, (any-hover: hover)
 * false — must not receive pointerType 'mouse' events, mouse wheels or mouse
 * clicks, because a real device with that profile cannot produce them.
 *
 * So every command that dispatches mouse input calls assertMouseCapable()
 * first. Keyboard-only commands (press, key-down/up, type-focused,
 * paste-focused), touch commands and drop-files are not gated.
 *
 * @module modality
 */

/** What the page says about its pointing devices (or null when it cannot be asked, e.g. mid-navigation). */
async function pointerProfile(page) {
  try {
    return await page.evaluate(() => ({
      anyFine: matchMedia('(any-pointer: fine)').matches,
      anyCoarse: matchMedia('(any-pointer: coarse)').matches,
      anyHover: matchMedia('(any-hover: hover)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
    }));
  } catch { return null; }
}

/** False only when the page positively reports that it has no fine pointing device. */
async function hasFinePointer(page) {
  const p = await pointerProfile(page);
  return p ? p.anyFine : true;          // unknown -> do not block (the command itself will fail if the page is gone)
}

/**
 * Refuse mouse input on a touch-only profile.
 * @param {import('patchright').Page} page
 * @param {string} what  the command, for the message
 */
async function assertMouseCapable(page, what) {
  const p = await pointerProfile(page);
  if (!p || p.anyFine) return;
  throw new Error(
    `mouse input refused: \`${what}\` is a mouse-driven command (pointer moves, clicks, drags, the wheel; the selector text commands ` +
    'fill / type / select / paste click their field to focus it), but this page reports no fine pointing device ' +
    `(matchMedia('(any-pointer: fine)') is false; any-pointer coarse=${p.anyCoarse}, any-hover=${p.anyHover}, maxTouchPoints=${p.maxTouchPoints}) - ` +
    "a touch-only device, which cannot produce pointerType 'mouse' events or a wheel. Sending them would be a physically impossible, " +
    'detectable contradiction (--raw does not lift this). On this profile use: tap / tap-at (touch), swipe (scroll), pinch (zoom), ' +
    'then type-focused / paste-focused / press / key-down / key-up for the keyboard (tap the field first), and drop-files for uploads. ' +
    'Mouse commands need a normal, non-touch daemon.');
}

module.exports = { pointerProfile, hasFinePointer, assertMouseCapable };
