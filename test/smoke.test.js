'use strict';

/**
 * Integration smoke test — real daemon, real browser, real navigation.
 *
 *   1. spawn `browser.js start` as a child process
 *   2. poll wait-ready until lockfile is alive
 *   3. one-shot: new, goto example.com, text h1, shot
 *   4. one-shot: stop
 *
 * Uses Node's built-in test runner — no external deps. Runs in CI against
 * bundled Chromium in headless mode; runs locally against system Chrome in
 * headed mode (the default). Isolates state by pointing NATIVEWRIGHT_HOME
 * and NATIVEWRIGHT_USER_DATA_DIR at a temp directory so the test never
 * touches the user's real persistent profile.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'src', 'browser.js');

// --- isolated test environment --------------------------------------------

function makeTmpDir(label) {
  const base = path.join(os.tmpdir(), `nativewright-test-${label}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

const TMP_HOME       = makeTmpDir('home');
const TMP_PROFILE    = makeTmpDir('profile');
const TMP_ARTIFACTS  = makeTmpDir('artifacts');

/** Env passed to all child processes. Falls back to the test's process.env for
 * everything we don't override explicitly so patchright still finds its cache.
 */
const childEnv = {
  ...process.env,
  NATIVEWRIGHT_HOME:          TMP_HOME,
  NATIVEWRIGHT_USER_DATA_DIR: TMP_PROFILE,
  NATIVEWRIGHT_ARTIFACTS_DIR: TMP_ARTIFACTS,
};

// CLI helper: synchronous call, returns parsed JSON result (or throws).
function cli(args, { timeout = 60_000 } = {}) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    env: childEnv,
    timeout,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  if (!out) {
    return { exitCode: res.status, body: null, stderr: res.stderr };
  }
  try {
    return { exitCode: res.status, body: JSON.parse(out), stderr: res.stderr };
  } catch {
    return { exitCode: res.status, body: null, raw: out, stderr: res.stderr };
  }
}

// --- lifecycle ------------------------------------------------------------

let daemon; // child_process handle

test('daemon boots, commands roundtrip, stops cleanly', async (t) => {
  // 1. start in background
  daemon = spawn(process.execPath, [ENTRY, 'start'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let daemonStdout = '';
  let daemonStderr = '';
  daemon.stdout.on('data', (c) => { daemonStdout += c; });
  daemon.stderr.on('data', (c) => { daemonStderr += c; });

  t.after(async () => {
    // Best-effort cleanup: if the test crashed before the explicit stop,
    // try to signal the daemon and then kill its process.
    try { cli(['stop'], { timeout: 10_000 }); } catch {}
    if (daemon && daemon.exitCode == null) {
      try { daemon.kill('SIGTERM'); } catch {}
    }
    // Give the profile dir a moment to flush before we rm -rf it.
    await new Promise((r) => setTimeout(r, 500));
    for (const d of [TMP_HOME, TMP_PROFILE, TMP_ARTIFACTS]) {
      try { await fsp.rm(d, { recursive: true, force: true }); } catch {}
    }
  });

  // 2. wait-ready
  const ready = cli(['wait-ready', '--timeout=60000']);
  assert.strictEqual(ready.exitCode, 0,
    `wait-ready failed.\nstderr: ${ready.stderr}\ndaemon stdout: ${daemonStdout}\ndaemon stderr: ${daemonStderr}`);
  assert.strictEqual(ready.body.ready, true, 'wait-ready did not report ready:true');
  assert.ok(ready.body.pid, 'wait-ready did not return a pid');

  // 3a. status is running
  const st = cli(['status']);
  assert.strictEqual(st.exitCode, 0);
  assert.strictEqual(st.body.running, true);

  // 3b. goto example.com
  const goto = cli(['goto', 'https://example.com/']);
  assert.strictEqual(goto.exitCode, 0,
    `goto failed: ${JSON.stringify(goto.body)}\nstderr: ${goto.stderr}`);
  assert.strictEqual(goto.body.ok, true);
  assert.match(goto.body.result.url, /example\.com/);

  // 3c. text h1 -> "Example Domain"
  const txt = cli(['text', 'h1']);
  assert.strictEqual(txt.exitCode, 0,
    `text failed: ${JSON.stringify(txt.body)}\nstderr: ${txt.stderr}`);
  assert.strictEqual(txt.body.ok, true);
  assert.match(txt.body.result.text, /Example Domain/i);

  // 3d. shot produces a non-empty PNG
  const shot = cli(['shot', 'smoke']);
  assert.strictEqual(shot.exitCode, 0);
  assert.strictEqual(shot.body.ok, true);
  const pngPath = shot.body.result.path;
  assert.ok(fs.existsSync(pngPath), `screenshot not on disk: ${pngPath}`);
  const { size } = fs.statSync(pngPath);
  assert.ok(size > 1000, `screenshot suspiciously small: ${size} bytes`);

  // 3d-bis. eval-file: read a JS file from disk and evaluate its full contents
  // in the page context (the path that injects large libs past the CLI arg limit).
  const efScript = path.join(TMP_ARTIFACTS, 'evalfile-probe.js');
  fs.writeFileSync(efScript, '(async () => { return { two: 1 + 1, title: document.title }; })()');
  const ef = cli(['eval-file', efScript]);
  assert.strictEqual(ef.exitCode, 0,
    `eval-file failed: ${JSON.stringify(ef.body)}\nstderr: ${ef.stderr}`);
  assert.strictEqual(ef.body.ok, true);
  assert.strictEqual(ef.body.result.value.two, 2, 'eval-file did not evaluate the expression');
  assert.match(ef.body.result.value.title, /Example Domain/i,
    'eval-file did not run in the page context');

  // 3d-ter. eval-file on a missing file -> ok:false, daemon stays alive.
  const efMissing = cli(['eval-file', path.join(TMP_ARTIFACTS, 'nope.js')]);
  assert.strictEqual(efMissing.exitCode, 1);
  assert.strictEqual(efMissing.body.ok, false);

  // 3e. unknown command -> daemon stays alive, ok:false
  const bad = cli(['does-not-exist']);
  assert.strictEqual(bad.exitCode, 1);
  assert.strictEqual(bad.body.ok, false);
  const stillUp = cli(['status']);
  assert.strictEqual(stillUp.body.running, true, 'daemon died on bad command');

  // 4. stop
  const stop = cli(['stop']);
  assert.strictEqual(stop.exitCode, 0);

  // 5. lockfile gone, daemon exited
  await new Promise((resolve) => daemon.once('exit', resolve));
  const after = cli(['status']);
  assert.strictEqual(after.body.running, false);
});
