'use strict';

/**
 * Integration smoke test — real daemon, real browser, real navigation.
 *
 *   1. spawn `browser.js start` as a child process
 *   2. poll wait-ready until lockfile is alive
 *   3. claim a page with `new` (stable id), drive it with --page
 *   4. contract checks: lone-page convenience, ambiguity refusal, stable ids,
 *      eval-file, stop refused while a page is open
 *   5. close the page, stop, verify clean exit
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
delete childEnv.NATIVEWRIGHT_PAGE;
delete childEnv.PATCHRIGHT_PAGE;

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

test('daemon boots, pages are isolated leases, commands roundtrip, stops cleanly', async (t) => {
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
    // force the daemon down (pages may still be open) and kill its process.
    try { cli(['stop', '--force'], { timeout: 10_000 }); } catch {}
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

  // 3a. status is running, no pages yet
  const st = cli(['status']);
  assert.strictEqual(st.exitCode, 0);
  assert.strictEqual(st.body.running, true);
  assert.strictEqual(st.body.pageCount, 0, 'fresh daemon should have no client pages');

  // 3b. page commands with no page open are refused with guidance
  const noPage = cli(['title']);
  assert.strictEqual(noPage.exitCode, 1);
  assert.match(noPage.body.error, /run `new` first/);

  // 3c. claim a page → stable id
  const created = cli(['new', '--label=smoke']);
  assert.strictEqual(created.exitCode, 0, `new failed: ${JSON.stringify(created.body)}`);
  assert.strictEqual(created.body.ok, true);
  const PAGE = created.body.result.page;
  assert.match(PAGE, /^p\d+$/, `unexpected page id: ${PAGE}`);
  assert.strictEqual(created.body.result.label, 'smoke');

  // 3d. goto example.com on that page
  const goto = cli(['goto', 'https://example.com/', `--page=${PAGE}`]);
  assert.strictEqual(goto.exitCode, 0,
    `goto failed: ${JSON.stringify(goto.body)}\nstderr: ${goto.stderr}`);
  assert.strictEqual(goto.body.ok, true);
  assert.strictEqual(goto.body.page, PAGE, 'response should echo the targeted page');
  assert.match(goto.body.result.url, /example\.com/);

  // 3e. text h1 -> "Example Domain" (lone page: --page may be omitted)
  const txt = cli(['text', 'h1']);
  assert.strictEqual(txt.exitCode, 0,
    `text failed: ${JSON.stringify(txt.body)}\nstderr: ${txt.stderr}`);
  assert.strictEqual(txt.body.ok, true);
  assert.strictEqual(txt.body.page, PAGE);
  assert.match(txt.body.result.text, /Example Domain/i);

  // 3f. shot produces a non-empty PNG
  const shot = cli(['shot', 'smoke', `--page=${PAGE}`]);
  assert.strictEqual(shot.exitCode, 0);
  assert.strictEqual(shot.body.ok, true);
  const pngPath = shot.body.result.path;
  assert.ok(fs.existsSync(pngPath), `screenshot not on disk: ${pngPath}`);
  const { size } = fs.statSync(pngPath);
  assert.ok(size > 1000, `screenshot suspiciously small: ${size} bytes`);

  // 3g. eval-file: evaluate a JS file's full contents in the page context
  const efScript = path.join(TMP_ARTIFACTS, 'evalfile-probe.js');
  fs.writeFileSync(efScript, '(async () => { return { two: 1 + 1, title: document.title }; })()');
  const ef = cli(['eval-file', efScript, `--page=${PAGE}`]);
  assert.strictEqual(ef.exitCode, 0,
    `eval-file failed: ${JSON.stringify(ef.body)}\nstderr: ${ef.stderr}`);
  assert.strictEqual(ef.body.ok, true);
  assert.strictEqual(ef.body.result.value.two, 2, 'eval-file did not evaluate the expression');
  assert.match(ef.body.result.value.title, /Example Domain/i, 'eval-file did not run in the page context');

  // 3h. eval-file on a missing file -> ok:false, daemon stays alive.
  const efMissing = cli(['eval-file', path.join(TMP_ARTIFACTS, 'nope.js'), `--page=${PAGE}`]);
  assert.strictEqual(efMissing.exitCode, 1);
  assert.strictEqual(efMissing.body.ok, false);

  // 4a. second page → targeting must now be explicit
  const second = cli(['new', '--label=second']);
  assert.strictEqual(second.body.ok, true);
  const PAGE2 = second.body.result.page;
  assert.notStrictEqual(PAGE2, PAGE, 'ids must be distinct');

  const ambiguous = cli(['title']);
  assert.strictEqual(ambiguous.exitCode, 1, 'omitting --page with 2 pages open must be refused');
  assert.match(ambiguous.body.error, /pass --page/);

  const unknown = cli(['title', '--page=p999']);
  assert.strictEqual(unknown.exitCode, 1);
  assert.match(unknown.body.error, /no page 'p999'/);

  const removed = cli(['switch', '0']);
  assert.strictEqual(removed.exitCode, 1);
  assert.match(removed.body.error, /no longer exists/);

  // 4b. each page still addressable, independently
  const t1 = cli(['title', `--page=${PAGE}`]);
  assert.strictEqual(t1.body.ok, true);
  assert.match(t1.body.result.title, /Example Domain/i);
  const t2 = cli(['title', `--page=${PAGE2}`]);
  assert.strictEqual(t2.body.ok, true);
  assert.strictEqual(t2.body.result.title, '', 'fresh about:blank page should have an empty title');

  // 4c. env pin works as a default --page
  const pinned = spawnSync(process.execPath, [ENTRY, 'url'], {
    env: { ...childEnv, NATIVEWRIGHT_PAGE: PAGE }, encoding: 'utf8', timeout: 30_000,
  });
  assert.strictEqual(pinned.status, 0, `env-pinned call failed: ${pinned.stdout} ${pinned.stderr}`);
  assert.match(JSON.parse(pinned.stdout).result.url, /example\.com/);

  // 4d. closing the second page leaves the first id intact (ids are stable)
  const closed2 = cli(['close', `--page=${PAGE2}`]);
  assert.strictEqual(closed2.body.ok, true);
  const list = cli(['pages']);
  assert.strictEqual(list.body.result.length, 1);
  assert.strictEqual(list.body.result[0].page, PAGE);

  // 4e. unknown command -> daemon stays alive, ok:false
  const bad = cli(['does-not-exist']);
  assert.strictEqual(bad.exitCode, 1);
  assert.strictEqual(bad.body.ok, false);

  // 5a. stop is refused while a page (lease) is open
  const refused = cli(['stop']);
  assert.strictEqual(refused.exitCode, 1, 'stop must refuse while pages are open');
  assert.match(refused.raw || '', /stop refused/);
  const stillUp = cli(['status']);
  assert.strictEqual(stillUp.body.running, true, 'daemon must survive a refused stop');

  // 5b. release the lease, then stop
  const closed = cli(['close', `--page=${PAGE}`]);
  assert.strictEqual(closed.body.ok, true);
  assert.strictEqual(closed.body.result.remaining, 0);

  const stop = cli(['stop']);
  assert.strictEqual(stop.exitCode, 0, `stop failed: ${stop.raw} ${stop.stderr}`);

  // 5c. lockfile gone, daemon exited
  await new Promise((resolve) => daemon.once('exit', resolve));
  const after = cli(['status']);
  assert.strictEqual(after.body.running, false);
});
