'use strict';

/**
 * `paste` / `paste-focused`: a REAL clipboard paste.
 *
 *   start the helper -> lock -> snapshot the OS clipboard -> write the payload ->
 *   human Ctrl+V (Control via Playwright's keyboard, V via the CDP key emitter) ->
 *   wait for the field to change -> verify -> restore the snapshot -> unlock
 *
 * The page receives a trusted `paste` event with clipboardData and a
 * `beforeinput` of inputType 'insertFromPaste' - verified in headed Chrome.
 *
 * The OS clipboard belongs to the human user (and is shared by every
 * nativewright daemon), so see ./clipboard.js for the rules: a machine-wide
 * lock; only an empty / plain-text-only clipboard is ever touched; restoration
 * only while the clipboard still holds our payload; contents never logged.
 * Whenever a real paste is not safe or not possible the text is HUMAN-TYPED
 * instead and the response says so (`method: 'typed'`, a short `reason` code and a
 * human-readable `detail`): 'headless' (its clipboard is in-process, not the OS
 * one), 'no-clipboard-tool', 'non-text clipboard', 'clipboard-busy',
 * 'clipboard-unreadable' (also: the clipboard helper could not be started),
 * 'clipboard-unwritable' (another application holds the clipboard open),
 * 'paste-no-effect'. Typing is for short texts: a text longer than
 * MAX_TYPED_FALLBACK_CHARS (2000 characters) is REFUSED when a fallback would
 * type it (an error naming the reason and the time it would take), because
 * typing it at a human's pace would block the page for many minutes.
 *
 * Inside the lock every helper call is short-bounded, and NO helper request may
 * outlive the lock: a helper that still owes an answer (a call timed out) could
 * perform that write/restore later, over whatever another daemon has put on the
 * clipboard by then - so it is killed before the lock is released, and the
 * restore is then made once through a fresh helper.
 *
 * @module paste
 */

const human = require('./human');
const clipboard = require('./clipboard');
const inspect = require('./inspect');
const timing = require('./timing');

// A paste that falls back to typing types at a human's pace (~190 ms a character): an unbounded text (headless, or a busy
// clipboard, plus --from-file up to 5 MB) would type for hours while the page's command queue is blocked. Past this many
// characters the fallback refuses instead (see viaTyping).
const MAX_TYPED_FALLBACK_CHARS = 2000;

// Starting the helper (PowerShell: 1-2 s, more under load) happens BEFORE the lock is taken, never inside it.
const WARM_TIMEOUT_MS = 20000;
// Every helper call made while the lock is held (snapshot / write / restore). Consistent with the helper's own bounded
// retries (about 2 s of retrying + at most one ~5 s OS stall in the clipboard call).
const IN_LOCK_TIMEOUT_MS = 10000;

const UNSURE_NOTE = 'the clipboard write was not confirmed and the helper was stopped, so the clipboard could not be confirmed unchanged';

/** A helper that still owes an answer is killed (the request could be carried out after the lock is gone). */
async function stopHelperIfBusy(backend) {
  try {
    if (typeof backend.hasUnanswered === 'function' && backend.hasUnanswered() && typeof backend.kill === 'function') {
      await backend.kill();
      return true;
    }
  } catch { /* best effort: the lock is released regardless */ }
  return false;
}

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const containsText = (haystack, needle) => norm(haystack).includes(norm(needle));

// A one-shot probe for the events a real paste produces (capture phase, isolated world).
async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__nw_probe_off) window.__nw_probe_off();
    const seen = { paste: null, inputFromPaste: false };
    const onPaste = (e) => { seen.paste = { trusted: e.isTrusted, types: Array.from(e.clipboardData ? e.clipboardData.types : []) }; };
    const onInput = (e) => { if (e.inputType === 'insertFromPaste') seen.inputFromPaste = true; };
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('input', onInput, true);
    window.__nw_probe = seen;
    window.__nw_probe_off = () => {
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('input', onInput, true);
      delete window.__nw_probe; delete window.__nw_probe_off;
    };
  }).catch(() => {});
}

async function readProbe(page) {
  try {
    return await page.evaluate(() => {
      const s = window.__nw_probe || null;
      if (window.__nw_probe_off) window.__nw_probe_off();
      return s;
    });
  } catch { return null; }
}

/**
 * Paste `text` into whatever is focused.
 * @param {{page, rec, session}} ctx
 * @param {string} text
 * @param {{rng: function, typos?: string, raw?: boolean, inLockTimeoutMs?: number, warmTimeoutMs?: number, maxTypedChars?: number}} o
 *   (the last three are for tests; the defaults are IN_LOCK_TIMEOUT_MS, WARM_TIMEOUT_MS and MAX_TYPED_FALLBACK_CHARS)
 * @returns {Promise<{method:'paste'|'typed', chars:number, verified:boolean, clipboardRestored:boolean, clipboardTouched:boolean, lockWaitMs:number, reason?:string}>}
 */
async function pasteFocused(ctx, text, o) {
  const { page, rec, session } = ctx;
  const rng = o.rng || Math.random;
  const t0 = Date.now();
  const chars = human.splitGraphemes(text).length;
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const result = {
    method: null, chars, verified: false,
    clipboardRestored: true, clipboardTouched: false, lockWaitMs: 0,
  };

  const viaTyping = async (reason, detail) => {
    const limit = o.maxTypedChars || MAX_TYPED_FALLBACK_CHARS;
    if (chars > limit) {
      const minutes = Math.max(1, Math.round(human.estimateTypingMs(chars) / 60000));
      throw new Error(
        `paste fell back to typing (reason '${reason}'${detail ? ': ' + detail : ''}), but the text is ${chars} characters long, ` +
        `more than the ${limit} a typed fallback is allowed: typing that much like a human would take about ${minutes} minute${minutes === 1 ? '' : 's'} ` +
        'and block this page the whole time, so nothing was typed. Use a headed daemon (NATIVEWRIGHT_HEADLESS unset) with an empty or ' +
        'plain-text clipboard so the paste is a real one, or `fill --raw=true` for bulk text.');
    }
    await human.humanType(page, text, { rng, typos: o.typos });
    const after = await inspect.readFocusedField(page);
    result.method = 'typed';
    result.reason = reason;
    if (detail) result.detail = detail;
    result.verified = after.kind !== 'none' && containsText(after.text, text);
    result.totalMs = Date.now() - t0;
    return result;
  };

  if (session && typeof session.isHeadless === 'function' && session.isHeadless()) {
    return viaTyping('headless', 'headless Chrome\'s clipboard is in-process, not the OS clipboard, so the text is typed');
  }
  const det = await clipboard.detectBackend();
  if (!det.backend) return viaTyping('no-clipboard-tool', det.reason);
  const backend = det.backend;
  const call = { timeoutMs: o.inLockTimeoutMs || IN_LOCK_TIMEOUT_MS };

  // Start the helper BEFORE taking the lock: a cold start inside the critical section would keep every other daemon's
  // paste waiting for it. (commands.js pre-warms it while the human click happens, so this is normally instant.)
  if (typeof backend.warm === 'function') {
    try { await backend.warm({ timeoutMs: o.warmTimeoutMs || WARM_TIMEOUT_MS }); }
    catch (e) { return viaTyping('clipboard-unreadable', 'the clipboard helper could not be started: ' + e.message); }
  }

  let lock;
  try { lock = await clipboard.acquireLock({ page: rec ? rec.id : null }); }
  catch (e) {
    if (e.code === 'CLIPBOARD_BUSY') { result.lockWaitMs = e.waitedMs || 0; return viaTyping('clipboard-busy', e.message); }
    throw e;
  }
  result.lockWaitMs = lock.waitedMs;

  let snap = null, wrote = false, writeUnsure = false, fallback = null;        // fallback = [reason, detail]
  try {
    try { snap = await backend.snapshot(call); }
    catch (e) { fallback = ['clipboard-unreadable', e.message]; }
    if (!fallback && snap.kind === 'other') {
      fallback = ['non-text clipboard', 'the clipboard holds data other than plain text (' + (snap.formats || []).join(', ') + '); it was left untouched'];
    }
    if (!fallback) {
      const before = await inspect.readFocusedField(page);
      await installProbe(page);
      // A write that fails half-way may still have changed the clipboard, so the restore below must run either way
      // (it is conditional on the clipboard holding exactly our payload). A locked clipboard (another application has it
      // open: clipboard managers do) is not an error for the caller: the text is typed instead.
      wrote = true;
      try { await backend.write(text, call); }
      catch (e) { fallback = ['clipboard-unwritable', e.message]; writeUnsure = !!(e && e.uncertain); }
      if (!fallback) {
        result.clipboardTouched = true;
        await human.sleep(human.logNormal(rng, 90, 0.3, 40, 200));
        if (o.raw) await page.keyboard.press(mod + '+V');
        else await human.humanPress(page, mod + '+v', { rng });

        // wait for the field to change (or for the page to report the paste): polling the page, no input event follows,
        // so a plain (coarse) sleep is enough
        const deadline = timing.now() + 4000;
        let after = before, probe = null, changed = false;
        while (timing.now() < deadline) {
          await human.coarseSleep(60);
          after = await inspect.readFocusedField(page);
          changed = after.text !== before.text;
          if (changed) break;
          probe = await page.evaluate(() => (window.__nw_probe ? { ...window.__nw_probe } : null)).catch(() => null);
          if (probe && probe.inputFromPaste) break;
        }
        probe = (await readProbe(page)) || probe;
        if (probe && probe.paste) result.pasteEvent = { trusted: !!probe.paste.trusted };
        if (changed || (probe && (probe.inputFromPaste || probe.paste))) {
          result.method = 'paste';
          result.verified = after.kind !== 'none' && containsText(after.text, text);
          if (!changed) result.note = 'paste event fired but the field text did not change';
        } else {
          fallback = ['paste-no-effect', 'Ctrl+V changed nothing and no paste event was seen'];
        }
      }
    }
  } finally {
    try {
      // Nothing the helper still owes may run after the lock is gone: a snapshot/write/restore that timed out here is
      // still queued in (or being run by) the helper. Kill it now; the restore below then goes through a fresh one.
      await stopHelperIfBusy(backend);
      if (wrote) {
        const r = await backend.restoreIfOurs(snap, text, call);
        await stopHelperIfBusy(backend);                        // the restore itself hung: do not leave it running
        if (fallback && fallback[0] === 'clipboard-unwritable') {
          // the write failed: normally the clipboard still holds the human's data and there is nothing to restore;
          // only if the failed write left our payload behind did the restore above put the original back
          if (r.restored) result.clipboardTouched = true;
          else if (writeUnsure || r.failed) {
            // the write may or may not have happened (the helper was stopped mid-way), or the restore could not even
            // look: do not claim a clean clipboard
            result.clipboardRestored = false;
            result.restoreNote = writeUnsure ? (r.reason ? UNSURE_NOTE + ' (' + r.reason + ')' : UNSURE_NOTE) : r.reason;
          }
        } else {
          result.clipboardRestored = !!r.restored;
          if (!r.restored && r.reason) result.restoreNote = r.reason;
        }
      }
    } finally {
      await lock.release();
    }
  }
  if (fallback) return viaTyping(fallback[0], fallback[1]);
  result.totalMs = Date.now() - t0;
  return result;
}

module.exports = { pasteFocused, containsText, MAX_TYPED_FALLBACK_CHARS };
