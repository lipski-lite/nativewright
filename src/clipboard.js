'use strict';

/**
 * OS clipboard access + a machine-wide lock, for the real-paste commands.
 *
 * The OS clipboard is shared with the human user and with EVERY nativewright
 * daemon (default + named profiles), so a paste is a critical section:
 *
 *   lock -> snapshot -> write payload -> Ctrl+V -> verify -> restore -> unlock
 *
 * Safety rules enforced here (the user's clipboard is their data):
 *   - Only a clipboard that is EMPTY or holds PLAIN TEXT ONLY is ever touched.
 *     Images, file lists, HTML/RTF and other formats are never overwritten;
 *     the caller falls back to human typing instead.
 *   - Restoration is conditional: the snapshot is written back only while the
 *     clipboard still holds exactly our payload. If the human copied something
 *     else meanwhile, theirs is left alone.
 *   - Clipboard contents are never logged or returned.
 *   - On Windows the payload (never the human's own text) is flagged to stay out of
 *     clipboard history, cloud clipboard sync and clipboard monitors that honour the flags.
 *   - The lock is held while its holder is alive (a heartbeat keeps it fresh), and no
 *     helper request may run after the lock is released (an unanswered one is killed).
 *
 * No dependencies: Windows uses a long-lived `powershell -STA` worker
 * (System.Windows.Forms.Clipboard), macOS pbpaste/pbcopy (+ osascript for the
 * type check), Linux wl-clipboard or xclip (xsel as a last resort). Text
 * crosses the process boundary as base64 UTF-8, so Unicode and newlines
 * survive intact.
 *
 * @module clipboard
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const cfg = require('./config');

// ---------------------------------------------------------------------------
// process helper (one-shot tools)
// ---------------------------------------------------------------------------

function run(cmd, args, { input, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e.message), error: e });
    }
    const out = [], err = [];
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ code: -2, stdout: Buffer.concat(out), stderr: 'timeout', timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => finish({ code: -1, stdout: Buffer.concat(out), stderr: String(e.message), error: e }));
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => { /* tool exited before reading stdin */ });
    child.stdin.end(input == null ? undefined : input);
  });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64').toString('utf8');

// ---------------------------------------------------------------------------
// Windows backend: a long-lived STA PowerShell worker (System.Windows.Forms)
// ---------------------------------------------------------------------------
// Starting PowerShell costs 1-2 s, so one worker is started lazily (and
// pre-warmed by the caller while the human click is still happening) and kept
// for a few minutes. Requests are single lines "<op> <id> <base64 args...>":
// no JSON on the way in (PowerShell 5.1's ConvertFrom-Json caps at 2 MB).
//
// THE WORKER PUMPS WINDOW MESSAGES WHENEVER IT IS IDLE. After any write the worker's hidden OLE
// clipboard window is the clipboard OWNER, and Windows waits for the owner when another process
// changes the clipboard. A worker parked in a blocking stdin read ([Console]::In.ReadLine()) does
// not dispatch messages. Measured on Windows 10 (separate processes, WinForms Clipboard API):
//   owner parked in ReadLine():  another process's WRITE took ~5000 ms (5016, 5008); its read 19 ms.
//                                When the owner's last operation was Clipboard.Clear() (our restore of an
//                                originally EMPTY clipboard), another process's READ (GetDataObject) hung for as
//                                long as the owner stayed parked: 11059 ms, done 30 ms after the owner was released.
//   owner pumping messages:      write 3 ms, read 15 ms; the read after a Clear() 45 ms.
//   no owner process:            write 3 ms, read 15 ms.
// So for the worker's whole 5-minute life any other application's copy could stall ~5 s (and, after a restore of an
// empty clipboard, its paste/read could hang), and concurrent daemons' workers starved each other (clipboard-unreadable
// / -busy, paste-no-effect fallbacks). The worker therefore reads stdin on a pool thread and, while it waits, pumps
// messages (PS_LOOP: every 200 ms - measured: with the poll at 200 instead of 25 ms the other process's write after a
// paste still took 3 ms and its read after a Clear() 26 ms, because SENT messages are served inside the CLR's pumping wait
// and the poll only drains the posted ones; the longer poll costs no latency and cuts the idle CPU), and every clipboard
// call is retried on a TIME budget (Retry), not in nested counted loops.

// Formats that are just different spellings of "plain text" on Windows. Anything
// else on the clipboard (Bitmap, FileDrop, HTML Format, Rich Text Format, the
// 'Chromium Web Custom MIME Data Format' Chrome adds on copy, ...) means the
// clipboard holds more than plain text and must not be touched.
const WIN_TEXT_FORMATS = ['UnicodeText', 'Text', 'OEMText', 'Locale', 'System.String'];

// Registered formats carried by the PAYLOAD only (never by the restore of the human's text): the first marks the
// content as not for clipboard monitors, the other two hold a DWORD 0 = not for Win+V history / cloud sync. All three
// are written as 4 zero bytes. The restore recognises our own payload as plain text + these three; a HUMAN clipboard
// that carries any of them (password managers set the first) is not plain text to classifyWindows: it is never read
// or touched.
const PAYLOAD_EXTRA_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'];

const PS_RETRY_BUDGET_MS = 2000;      // a busy clipboard is retried for about this long, then the operation fails
const PS_SET_TRIES = 4, PS_SET_DELAY_MS = 40;   // SetDataObject's own retries (OpenClipboard): ~160 ms, inside Retry's budget

const PS_COMMON = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$RetryBudgetMs = ${PS_RETRY_BUDGET_MS}
function Retry([scriptblock]$sb) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try { return (& $sb) }
    catch {
      if ($sw.ElapsedMilliseconds -ge $RetryBudgetMs) { throw }
      PumpMessages
      Start-Sleep -Milliseconds 30
    }
  }
}
function ToB64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function FromB64([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
$TextFormats = @('UnicodeText', 'Text', 'OEMText', 'Locale', 'System.String')
$PayloadFormats = @(${PAYLOAD_EXTRA_FORMATS.map((f) => `'${f}'`).join(', ')})
$OurFormats = $TextFormats + $PayloadFormats
$Dword0 = [byte[]](0, 0, 0, 0)
`;

// The real OS clipboard (System.Windows.Forms). The text is read ONLY when the clipboard holds nothing but plain
// text: anything else (images, files, HTML, a password manager's entry...) is reported by format name alone and
// its content is never touched.
const PS_REAL_CLIPBOARD = `
$FakeMode = $false
Add-Type -AssemblyName System.Windows.Forms
function PumpMessages { [System.Windows.Forms.Application]::DoEvents() }
function ClipRead([string[]]$allowed = $TextFormats) {
  Retry {
    $d = [System.Windows.Forms.Clipboard]::GetDataObject()
    $fmts = @(); $text = $null
    if ($d -ne $null) {
      $fmts = @($d.GetFormats($false))
      $extra = @($fmts | Where-Object { $allowed -notcontains $_ })
      if ($extra.Count -eq 0 -and $d.GetDataPresent([System.Windows.Forms.DataFormats]::UnicodeText, $false)) {
        $text = [string]$d.GetData([System.Windows.Forms.DataFormats]::UnicodeText, $false)
      }
    }
    @{ formats = $fmts; text = $(if ($text -ne $null) { ToB64 $text } else { $null }) }
  }
}
function ClipWrite([string]$t) {
  if ($t.Length -eq 0) { $null = Retry { [System.Windows.Forms.Clipboard]::Clear() } }
  else { $null = Retry { [System.Windows.Forms.Clipboard]::SetText($t, [System.Windows.Forms.TextDataFormat]::UnicodeText) } }
}
function ClipWritePayload([string]$t) {
  if ($t.Length -eq 0) { ClipWrite ''; return }
  $do = New-Object System.Windows.Forms.DataObject
  $do.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $false, $t)
  foreach ($f in $PayloadFormats) { $do.SetData($f, $false, (New-Object System.IO.MemoryStream -ArgumentList (,$Dword0))) }
  $null = Retry { [System.Windows.Forms.Clipboard]::SetDataObject($do, $true, ${PS_SET_TRIES}, ${PS_SET_DELAY_MS}) }
}
`;

// An in-memory stand-in used by the test-suite ONLY (makeWindowsBackend({ fake: true })): the same protocol and
// the same logic around it, without touching the human's clipboard. The daemon never selects it. It has no window
// messages to pump (PumpMessages does nothing) unless a test arms the pump probe ('pumparm').
const PS_FAKE_CLIPBOARD = `
$FakeMode = $true
$script:FakeFormats = @()
$script:FakeText = $null
$script:FakePump = $false
$script:PumpHits = 0
$script:HangWriteMs = 0
function PumpMessages { if ($script:FakePump) { [System.Windows.Forms.Application]::DoEvents() } }
function ClipRead([string[]]$allowed = $TextFormats) {
  $extra = @($script:FakeFormats | Where-Object { $allowed -notcontains $_ })
  $text = $null
  if ($extra.Count -eq 0 -and $script:FakeText -ne $null) { $text = $script:FakeText }
  @{ formats = @($script:FakeFormats); text = $(if ($text -ne $null) { ToB64 $text } else { $null }) }
}
function ClipWrite([string]$t) {
  if ($t.Length -eq 0) { $script:FakeFormats = @(); $script:FakeText = $null }
  else { $script:FakeFormats = @('UnicodeText', 'Text', 'OEMText', 'Locale'); $script:FakeText = $t }
}
function ClipWritePayload([string]$t) {
  if ($t.Length -eq 0) { ClipWrite ''; return }
  $script:FakeFormats = @('UnicodeText', 'Text', 'OEMText', 'Locale') + $PayloadFormats
  $script:FakeText = $t
}
`;

const PS_LOOP = `
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $t = $stdin.ReadLineAsync()
  while (-not $t.Wait(200)) { PumpMessages }
  $line = $t.Result
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  $id = $p[1]
  try {
    if (-not $FakeMode -and @('seed', 'peek', 'stall', 'hangwrite', 'pumparm', 'pumphits', 'retryprobe') -contains $p[0]) { throw 'test hooks exist only on the in-memory test clipboard' }
    switch ($p[0]) {
      'ping'     { $r = @{ ok = $true } }
      'snapshot' { $r = ClipRead }
      'write'    {
        if ($script:HangWriteMs -gt 0) { Start-Sleep -Milliseconds $script:HangWriteMs; $script:HangWriteMs = 0 }
        ClipWritePayload (FromB64 $p[2]); $r = @{ ok = $true }
      }
      'restore'  {
        # restore <id> <payloadB64> <restoreB64|->  : only while the clipboard still holds exactly our payload (plain text
        # + the payload's own flag formats). The human's text goes back as plain text; '-' = it was empty: clear.
        $cur = ClipRead $OurFormats
        if ($cur.text -ne $null -and $cur.text -ceq $p[2]) {
          if ($p[3] -eq '-') { ClipWrite '' } else { ClipWrite (FromB64 $p[3]) }
          $r = @{ restored = $true }
        } else { $r = @{ restored = $false; reason = 'clipboard changed meanwhile; left as is' } }
      }
      'seed'     {
        # seed <id> <formatsCsvB64|-> <textB64|->  : set the in-memory test clipboard (never available on the real one)
        if ($p[2] -eq '-') { $script:FakeFormats = @() } else { $script:FakeFormats = @((FromB64 $p[2]).Split(',')) }
        if ($p[3] -eq '-') { $script:FakeText = $null } else { $script:FakeText = FromB64 $p[3] }
        $r = @{ ok = $true }
      }
      'peek'     { $r = @{ formats = @($script:FakeFormats); text = $(if ($script:FakeText -ne $null) { ToB64 $script:FakeText } else { $null }) } }
      'stall'    { Start-Sleep -Milliseconds ([int]$p[2]); $r = @{ ok = $true } }
      'hangwrite' { $script:HangWriteMs = [int]$p[2]; $r = @{ ok = $true } }
      'pumparm'  {
        # a WinForms timer only ticks if this thread pumps messages: proves the idle loop does
        Add-Type -AssemblyName System.Windows.Forms
        $script:FakePump = $true
        $script:Timer = New-Object System.Windows.Forms.Timer
        $script:Timer.Interval = 40
        $script:Timer.add_Tick({ $script:PumpHits++ })
        $script:Timer.Start()
        $r = @{ ok = $true }
      }
      'pumphits' { $r = @{ hits = $script:PumpHits } }
      'retryprobe' {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try { $null = Retry { throw 'always fails' } } catch { }
        $r = @{ ms = $sw.ElapsedMilliseconds }
      }
      default { throw 'unknown op' }
    }
    $r['id'] = $id
    [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 4))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

function workerScript(fake) { return PS_COMMON + (fake ? PS_FAKE_CLIPBOARD : PS_REAL_CLIPBOARD) + PS_LOOP; }

// An error whose operation may still have happened (it timed out, or the helper ended while it was in flight): the
// caller cannot know whether the clipboard changed.
const unsure = (e) => { e.uncertain = true; return e; };

class PsWorker {
  constructor(script, idleMs = 5 * 60 * 1000) {
    this.script = script;
    this.idleMs = idleMs;                       // the helper goes after this long without a request (tests shorten it)
    this.child = null; this.pending = new Map(); this.buf = '';
    // ids of the requests written to the helper whose reply has not arrived - including those the caller already gave
    // up on (timed out): the helper may still perform them. Cleared when the helper is gone.
    this.inflight = new Set();
    this.nextId = 1; this.idle = null; this.ready = null; this.die = null;
  }

  start() {
    if (this.child) return this.ready;
    const enc = Buffer.from(this.script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.buf = '';
    this.inflight.clear();
    let errText = '';
    child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
    let onReady, onDead;
    this.ready = new Promise((resolve, reject) => { onReady = resolve; onDead = reject; });
    this.ready.catch(() => {});                 // no unhandled rejection when nobody awaits it
    child.stdout.on('data', (c) => {
      if (this.child !== child) return;         // output of a helper we already gave up on
      this.buf += c.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) { onReady(); continue; }
        const id = String(msg.id);
        this.inflight.delete(id);               // answered (also a late answer to a request that timed out)
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); p.resolve(msg); }
      }
    });
    const die = (why, deliberate = false) => {
      if (this.child !== child) return;
      this.child = null;
      this.inflight.clear();
      const text = 'clipboard helper ended: ' + why + (errText && !deliberate ? ' ' + errText.trim().slice(0, 200) : '');
      onDead(new Error(text));
      for (const [, p] of this.pending) p.reject(unsure(new Error(text)));
      this.pending.clear();
    };
    this.die = die;
    child.on('error', (e) => die(e.message));
    child.on('exit', (code) => die('exit ' + code));
    child.stdin.on('error', () => {});
    return this.ready;
  }

  /** start(), but a helper that is not ready within `ms` is killed and reported (a hung start must not hold the caller). */
  async startWithin(ms) {
    const ready = this.start();
    if (!(ms > 0)) return ready;
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('clipboard helper did not start within ' + ms + ' ms'), { startTimeout: true })), ms);
    });
    try { return await Promise.race([ready, limit]); }
    catch (e) { if (e && e.startTimeout) await this.kill(); throw e; }
    finally { clearTimeout(timer); }
  }

  /** Let the helper go after a few idle minutes (it also exits if the daemon dies: its stdin closes). */
  armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.idleMs);
    if (this.idle.unref) this.idle.unref();
  }

  /**
   * Start (or reuse) the worker and wait until it is ready (`timeoutMs`: kill it if it is not). The idle time starts
   * over, so a helper that is warmed just before the paste lock is taken cannot be released while the paste waits for it.
   */
  async warm({ timeoutMs } = {}) {
    await this.startWithin(timeoutMs);
    if (this.child) this.armIdle();
  }

  /** True while the helper still owes an answer (it may yet perform that request). */
  hasUnanswered() { return !!this.child && this.inflight.size > 0; }

  /**
   * One request. `timeoutMs` bounds the WHOLE call, a cold start included. A timed-out request stays counted as
   * unanswered (hasUnanswered) until its late reply arrives or the helper is killed.
   */
  async call(op, args = [], timeoutMs = 20000) {
    const t0 = Date.now();
    await this.startWithin(timeoutMs);
    if (!this.child) throw new Error('clipboard helper not running');
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const id = String(this.nextId++);
    const left = Math.max(Math.min(500, timeoutMs), timeoutMs - (Date.now() - t0));   // what is left after a cold start
    const reply = new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(unsure(new Error('clipboard helper timed out (' + op + ')'))); }, left);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
    reply.catch(() => {});                      // awaited below; no unhandled rejection if the write itself throws first
    this.inflight.add(id);
    this.child.stdin.write([op, id, ...args].join(' ') + '\n');
    try { return await reply; }
    finally { if (this.child) this.armIdle(); }
  }

  /**
   * Terminate the helper NOW (TerminateProcess - not the graceful stdin-EOF path of stop()) and wait, bounded, until
   * the process is gone, so nothing it was still asked to do can happen afterwards. Pending calls are rejected; the
   * next call() starts a fresh helper.
   */
  async kill(waitMs = 2000) {
    const c = this.child;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (!c) return;
    const gone = new Promise((resolve) => {
      if (c.exitCode != null || c.signalCode != null) resolve(); else c.once('exit', resolve);
    });
    if (this.die) this.die('stopped by nativewright', true);   // forget it first: pending calls fail, its output is ignored
    try { c.kill(); } catch { /* already gone */ }
    let timer;
    await Promise.race([gone, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  }

  stop() {
    const c = this.child;
    this.child = null;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (c) {
      try { c.stdin.end(); } catch { /* ignore */ }
      const k = setTimeout(() => { try { c.kill(); } catch { /* ignore */ } }, 500);
      if (k.unref) k.unref();
    }
  }
}

function classifyWindows(formats) {
  const f = (Array.isArray(formats) ? formats : formats ? [formats] : []).map(String);
  const extra = f.filter((x) => !WIN_TEXT_FORMATS.includes(x));
  if (f.length === 0) return { kind: 'empty', formats: f };
  if (extra.length) return { kind: 'other', formats: f, extra };
  return { kind: 'text', formats: f };
}

/**
 * The Windows backend. Backend interface (every backend): name, warm({timeoutMs}), dispose(), hasUnanswered(), kill(),
 * snapshot({timeoutMs}), write(text, {timeoutMs}), restoreIfOurs(snap, payload, {timeoutMs}). `timeoutMs` bounds one
 * helper call (cold start included); calls made inside the paste lock pass a short one.
 */
function makeWindowsBackend({ fake = false, idleMs } = {}) {
  const w = new PsWorker(workerScript(fake), idleMs);
  const must = (m) => { if (m.error) throw new Error('clipboard: ' + m.error); return m; };
  const ms = (o) => (o && o.timeoutMs) || undefined;     // undefined -> the call's default
  const backend = {
    name: fake ? 'windows-powershell-fake' : 'windows-powershell',
    warm: (o) => w.warm(o),
    dispose: () => w.stop(),
    /** The helper still owes an answer: a request that timed out may yet be carried out by it. */
    hasUnanswered: () => w.hasUnanswered(),
    /** Terminate the helper immediately (and wait, bounded, for it to be gone); the next call starts a new one. */
    kill: () => w.kill(),
    async snapshot(o) {
      const j = must(await w.call('snapshot', [], ms(o)));
      const cls = classifyWindows(j.formats);
      const text = j.text != null ? unb64(j.text) : null;
      // A clipboard that lists text formats but yields no text is odd: treat as non-text.
      if (cls.kind === 'text' && text == null) return { kind: 'other', formats: cls.formats };
      return { kind: cls.kind, formats: cls.formats, text: cls.kind === 'text' ? text : null };
    },
    async write(text, o) { must(await w.call('write', [b64(text)], ms(o))); },
    async restoreIfOurs(snap, payload, o) {
      const keep = snap.kind === 'text' && snap.text !== '' ? b64(snap.text) : '-';
      try {
        const m = await w.call('restore', [b64(payload), keep], ms(o));
        if (m.error) return { restored: false, failed: true, reason: 'restore failed: ' + m.error };
        return m.reason ? { restored: !!m.restored, reason: m.reason } : { restored: !!m.restored };
      } catch (e) { return { restored: false, failed: true, reason: 'restore failed: ' + e.message }; }
    },
  };
  if (fake) {
    // test hooks (the in-memory clipboard only): put formats / text on it, look at it unfiltered, and make the helper
    // misbehave (stall, hang the next write) or prove it pumps messages / bounds its retries
    const hook = async (op, args = [], o) => must(await w.call(op, args, ms(o)));
    backend.seed = (formats, text) => hook('seed', [formats && formats.length ? b64(formats.join(',')) : '-', text == null ? '-' : b64(text)]);
    backend.peek = async () => {
      const j = await hook('peek');
      return { formats: Array.isArray(j.formats) ? j.formats : (j.formats ? [j.formats] : []), text: j.text != null ? unb64(j.text) : null };
    };
    backend.stall = (stallMs, o) => hook('stall', [String(stallMs)], o);
    backend.hangNextWrite = (hangMs) => hook('hangwrite', [String(hangMs)]);
    backend.pumpArm = () => hook('pumparm');
    backend.pumpHits = async () => (await hook('pumphits')).hits;
    backend.retryProbeMs = async () => (await hook('retryprobe')).ms;
    backend.pid = () => (w.child ? w.child.pid : null);
  }
  return backend;
}

// ---------------------------------------------------------------------------
// macOS backend (pbpaste / pbcopy; osascript for the type check)
// ---------------------------------------------------------------------------

const macBackend = {
  name: 'macos-pbcopy',
  warm: async () => {},
  dispose: () => {},
  hasUnanswered: () => false,       // one-shot tools with their own timeouts: nothing outlives a call
  kill: async () => {},
  async snapshot() {
    const info = await run('osascript', ['-e', 'clipboard info'], { timeoutMs: 8000 });
    if (info.code !== 0) throw new Error('clipboard type check failed');
    const raw = info.stdout.toString('utf8').trim();
    // "clipboard info" -> "{{string, 12}, {«class utf8», 12}}" or "{}" / "" when empty
    const types = [...raw.matchAll(/\{\s*([^,{}]+?)\s*,\s*\d+\s*\}/g)].map((m) => m[1].trim());
    if (types.length === 0) return { kind: 'empty', formats: [] };
    const textish = (t) => /^(string|Unicode text|text)$/i.test(t) || /utf8|ut16/i.test(t);
    if (!types.every(textish)) return { kind: 'other', formats: types };
    const r = await run('pbpaste', [], { timeoutMs: 8000 });
    if (r.code !== 0) throw new Error('pbpaste failed');
    return { kind: 'text', formats: types, text: r.stdout.toString('utf8') };
  },
  async write(text) {
    const r = await run('pbcopy', [], { input: Buffer.from(text, 'utf8'), timeoutMs: 8000 });
    if (r.code !== 0) throw new Error('pbcopy failed');
  },
  async restoreIfOurs(snap, payload) {
    const cur = await run('pbpaste', [], { timeoutMs: 8000 });
    if (cur.code !== 0 || cur.stdout.toString('utf8') !== payload) {
      return { restored: false, reason: 'clipboard changed meanwhile; left as is' };
    }
    const text = snap.kind === 'text' ? snap.text : '';
    await run('pbcopy', [], { input: Buffer.from(text, 'utf8'), timeoutMs: 8000 });
    return { restored: true };
  },
};

// ---------------------------------------------------------------------------
// Linux backends (wl-clipboard, xclip, xsel)
// ---------------------------------------------------------------------------

const LINUX_TEXT_TARGETS = /^(text\/plain(;charset=.*)?|UTF8_STRING|STRING|TEXT|COMPOUND_TEXT|TARGETS|TIMESTAMP|MULTIPLE|SAVE_TARGETS)$/i;

function linuxBackend(tool) {
  const targetsCmd = tool === 'wl'
    ? ['wl-paste', ['--list-types']]
    : ['xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']];
  const readCmd = tool === 'wl' ? ['wl-paste', ['--no-newline']]
    : tool === 'xclip' ? ['xclip', ['-selection', 'clipboard', '-o']]
      : ['xsel', ['--clipboard', '--output']];
  const writeCmd = tool === 'wl' ? ['wl-copy', []]
    : tool === 'xclip' ? ['xclip', ['-selection', 'clipboard', '-i']]
      : ['xsel', ['--clipboard', '--input']];
  const clearCmd = tool === 'wl' ? ['wl-copy', ['--clear']]
    : tool === 'xclip' ? ['xclip', ['-selection', 'clipboard', '-i']] : ['xsel', ['--clipboard', '--clear']];

  return {
    name: tool === 'wl' ? 'linux-wl-clipboard' : tool === 'xclip' ? 'linux-xclip' : 'linux-xsel',
    warm: async () => {},
    dispose: () => {},
    hasUnanswered: () => false,
    kill: async () => {},
    async snapshot() {
      let types = null;
      if (tool !== 'xsel') {
        const t = await run(targetsCmd[0], targetsCmd[1], { timeoutMs: 6000 });
        if (t.code === 0) types = t.stdout.toString('utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        else if (/no selection|nothing is copied|target .* not available|Error: Can't/i.test(t.stderr)) types = [];
      }
      if (types && types.length === 0) return { kind: 'empty', formats: [] };
      if (types && !types.every((x) => LINUX_TEXT_TARGETS.test(x))) return { kind: 'other', formats: types };
      const r = await run(readCmd[0], readCmd[1], { timeoutMs: 6000 });
      const text = r.stdout.toString('utf8');
      if (r.code !== 0 && !text) return { kind: 'empty', formats: types || [] };
      // xsel cannot list targets: an empty read is ambiguous (empty vs image), so do not touch it
      if (!types && text === '') return { kind: 'other', formats: ['unknown'] };
      return { kind: 'text', formats: types || ['text'], text };
    },
    async write(text) {
      const r = await run(writeCmd[0], writeCmd[1], { input: Buffer.from(text, 'utf8'), timeoutMs: 6000 });
      if (r.code !== 0) throw new Error(writeCmd[0] + ' failed');
    },
    async restoreIfOurs(snap, payload) {
      const cur = await run(readCmd[0], readCmd[1], { timeoutMs: 6000 });
      if (cur.stdout.toString('utf8') !== payload) return { restored: false, reason: 'clipboard changed meanwhile; left as is' };
      if (snap.kind === 'text' && snap.text !== '') {
        await run(writeCmd[0], writeCmd[1], { input: Buffer.from(snap.text, 'utf8'), timeoutMs: 6000 });
      } else {
        await run(clearCmd[0], clearCmd[1], { input: '', timeoutMs: 6000 });
      }
      return { restored: true };
    },
  };
}

async function hasTool(cmd) {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeoutMs: 3000 });
  return r.code === 0;
}

let _backend; // cached: { backend } | { reason }
/** @returns {Promise<{backend?: object, reason?: string}>} */
async function detectBackend() {
  if (_backend) return _backend;
  if (process.platform === 'win32') _backend = { backend: makeWindowsBackend() };
  else if (process.platform === 'darwin') _backend = { backend: macBackend };
  else if (process.env.WAYLAND_DISPLAY && await hasTool('wl-paste') && await hasTool('wl-copy')) _backend = { backend: linuxBackend('wl') };
  else if (process.env.DISPLAY && await hasTool('xclip')) _backend = { backend: linuxBackend('xclip') };
  else if (process.env.DISPLAY && await hasTool('xsel')) _backend = { backend: linuxBackend('xsel') };
  else _backend = { reason: 'no OS clipboard tool available (need wl-clipboard, xclip or xsel)' };
  return _backend;
}

// ---------------------------------------------------------------------------
// Machine-wide (per OS user) lock: <os.tmpdir()>/nativewright-clipboard.lock,
// created with flag 'wx'. Independent of NATIVEWRIGHT_HOME on purpose.
// File content: { pid, page, id, at, hb } - id = random per acquisition, at = when it was acquired, hb = the holder's
// last heartbeat. A holder that is alive keeps hb fresh, so it is never reaped however long it holds the lock (a slow
// paste); a holder that died (pid gone) or froze (no heartbeat for staleMs) is reaped.
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 15000;      // no heartbeat for this long = the holder is gone
const LOCK_WAIT_MS = 10000;       // a waiter gives up (and types instead) after this long
const LOCK_HEARTBEAT_MS = 1000;

/**
 * The lock file. The OS clipboard is global to the OS USER SESSION, not to any nativewright data root, so the
 * lock must be too: daemons with different NATIVEWRIGHT_HOME roots (separate identities, named profiles under
 * another root, isolated test daemons) must contend on the SAME lock, otherwise concurrent pastes cross-talk.
 * os.tmpdir() is per-user on Windows (%TEMP%) and macOS ($TMPDIR); on Linux/BSD it is a shared /tmp, so the
 * uid is part of the name there.
 */
function lockPath() {
  const sharedTmp = process.platform !== 'win32' && process.platform !== 'darwin';
  const uid = sharedTmp && typeof process.getuid === 'function' ? process.getuid() : null;
  return path.join(os.tmpdir(), uid == null ? 'nativewright-clipboard.lock' : `nativewright-clipboard-${uid}.lock`);
}

function parseLock(text) {
  try { const l = JSON.parse(text); return l && typeof l === 'object' ? l : null; }
  catch { return null; }
}

async function readLock(file) {
  try { return parseLock(await fsp.readFile(file, 'utf8')); }
  catch { return null; }
}

/** Is the lock file content `cur` the lock described by `ref`? By id; by pid + acquisition time only for a file without one. */
function sameLock(cur, ref) {
  if (cur.id != null) return cur.id === ref.id;
  return cur.pid === ref.pid && cur.at === ref.at;
}

/**
 * Acquire the clipboard lock; waits up to `waitMs`. A lock is stale when its
 * owner pid is dead or its holder has not heartbeaten for `staleMs` (a file
 * without a heartbeat counts from its acquisition time `at`). The holder
 * refreshes the heartbeat every `heartbeatMs` until release(). `file`
 * overrides the lock path (tests only: the default is the machine-wide,
 * per-user lock).
 * @returns {Promise<{release: () => Promise<void>, waitedMs: number}>}
 */
async function acquireLock({ page = null, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS, file = lockPath() } = {}) {
  cfg.ensureDir(path.dirname(file));
  const started = Date.now();
  const me = { pid: process.pid, page, id: crypto.randomBytes(8).toString('hex'), at: 0, hb: 0 };
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(file, 'wx'); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd != null) {
      try {
        me.at = me.hb = Date.now();             // acquisition time, not the moment we started waiting
        fs.writeSync(fd, JSON.stringify(me));
      } catch (e) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        throw e;
      }
      fs.closeSync(fd);
      // heartbeat: prove we are alive. 'r+' never creates the file, so a lock that was released or reaped is not
      // resurrected, and a file that is no longer ours (reaped while this process was frozen) is left alone.
      const beat = () => {
        let h = null;
        try {
          h = fs.openSync(file, 'r+');
          const cur = parseLock(fs.readFileSync(h, 'utf8'));
          if (!cur || !sameLock(cur, me)) { clearInterval(timer); return; }
          me.hb = Date.now();
          const json = JSON.stringify(me);
          fs.writeSync(h, json, 0);
          fs.ftruncateSync(h, Buffer.byteLength(json));
        } catch { /* a missed beat is harmless: the next one follows */ }
        finally { if (h != null) { try { fs.closeSync(h); } catch { /* ignore */ } } }
      };
      const timer = setInterval(beat, Math.max(10, heartbeatMs));
      if (timer.unref) timer.unref();
      return {
        waitedMs: Date.now() - started,
        async release() {
          clearInterval(timer);
          // only remove a lock that is still ours
          const cur = await readLock(file);
          if (cur && sameLock(cur, me)) { try { await fsp.unlink(file); } catch { /* gone */ } }
        },
      };
    }
    // held by someone: stale?
    const cur = await readLock(file);
    let stale = false;
    if (!cur || typeof cur.at !== 'number') {
      // unreadable / half-written: stale only if the file itself is old
      try { stale = Date.now() - fs.statSync(file).mtimeMs > staleMs; } catch { stale = false; }
    } else {
      stale = !cfg.pidAlive(cur.pid) || Date.now() - (typeof cur.hb === 'number' ? cur.hb : cur.at) > staleMs;
    }
    if (stale) {
      // re-check right before removing so we never delete a lock someone else just took
      const again = await readLock(file);
      if ((!cur && !again) || (cur && again && sameLock(again, cur))) {
        try { await fsp.unlink(file); } catch { /* raced */ }
      }
      continue;
    }
    if (Date.now() - started >= waitMs) {
      const err = new Error(`clipboard busy: another nativewright paste (pid ${cur && cur.pid}) holds the lock`);
      err.code = 'CLIPBOARD_BUSY';
      err.waitedMs = Date.now() - started;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 80));
  }
}

/** Stop the Windows PowerShell helper, if one is running (called when the daemon shuts down). */
function dispose() {
  if (_backend && _backend.backend && _backend.backend.dispose) _backend.backend.dispose();
}

module.exports = {
  detectBackend, acquireLock, lockPath, dispose,
  LOCK_STALE_MS, LOCK_WAIT_MS, LOCK_HEARTBEAT_MS,
  _classifyWindows: classifyWindows, _makeWindowsBackend: makeWindowsBackend, _workerScript: workerScript, // exported for tests
};
