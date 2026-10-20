'use strict';

/**
 * Path, lockfile, logging and Chrome-detection helpers for the
 * NativeWright browser daemon.
 *
 * Cross-platform:
 *   Windows   — %LOCALAPPDATA%\NativeWright\
 *   macOS     — ~/Library/Application Support/NativeWright/
 *   Linux/BSD — ${XDG_DATA_HOME:-~/.local/share}/nativewright/
 *
 * All public helpers are environment-variable-driven, so tests and
 * advanced users can redirect every path without touching the code.
 * Every variable is read under the `NATIVEWRIGHT_` prefix first and the
 * legacy `PATCHRIGHT_` prefix second, so an operator following either
 * spelling is never silently ignored.
 *
 * @module config
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');

/**
 * Read an env var by suffix under both accepted prefixes.
 * @param {string} suffix e.g. 'USER_DATA_DIR'
 * @returns {string} value or '' when unset
 */
function envAny(suffix) {
  return process.env['NATIVEWRIGHT_' + suffix] || process.env['PATCHRIGHT_' + suffix] || '';
}

// ---------- platform-aware root directory ---------------------------------

/**
 * Resolve the per-user data root used by NativeWright.
 *
 * Precedence:
 *   1. $NATIVEWRIGHT_HOME (explicit override)
 *   2. platform default (see module comment)
 *
 * @returns {string} absolute directory path
 */
function nativewrightHome() {
  const forced = envAny('HOME');
  if (forced) return forced;
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, 'NativeWright');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'NativeWright');
  }
  // linux, freebsd, etc.
  const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdg, 'nativewright');
}

/**
 * Named profile selected for this process (`--profile=<name>` on the CLI,
 * or NATIVEWRIGHT_PROFILE). `null` means the default profile.
 *
 * A named profile is a fully separate browser identity: its own data root
 * `<home>/profiles/<name>/` holding its own lockfile, logs and Chrome
 * profile — so it runs as its own daemon, with its own cookies, extensions
 * and network settings, and never touches the default profile's sessions.
 *
 * @returns {string|null}
 */
function profileName() {
  const v = envAny('PROFILE');
  if (!v || v === 'default') return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(v)) {
    throw new Error(`invalid profile name '${v}' (letters, digits, '-' and '_', max 32 chars)`);
  }
  return v.toLowerCase();
}

const PROFILE         = profileName();
const BASE_HOME       = nativewrightHome();
const ROOT_DIR        = PROFILE ? path.join(BASE_HOME, 'profiles', PROFILE) : BASE_HOME;
const LOCK_FILE       = path.join(ROOT_DIR, 'daemon.json');
const INSTALL_FILE    = path.join(ROOT_DIR, 'install.json');
const LOG_DIR         = path.join(ROOT_DIR, 'logs');
const LOG_FILE        = path.join(LOG_DIR, 'daemon.log');
const DEFAULT_PROFILE = path.join(ROOT_DIR, 'profile', 'default');

/**
 * Graceful idle exit: after the LAST client page has been closed for this
 * long, the daemon shuts down cleanly (the browser flushes cookies/tokens
 * to the profile). `0` disables idle exit — the daemon stays resident until
 * an explicit `stop`.
 * @type {number} milliseconds
 */
const IDLE_EXIT_MS = (() => {
  const v = envAny('IDLE_EXIT_MS');
  if (v === '') return 10 * 60 * 1000;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
})();

/**
 * Persistent browser profile directory (overridable via env).
 * @returns {string}
 */
function userDataDir() {
  // A named profile always owns its directory: NATIVEWRIGHT_USER_DATA_DIR is
  // commonly set machine-wide to point at the DEFAULT profile, and honouring
  // it here would make a named-profile daemon fight the default daemon for
  // the same Chrome profile lock.
  if (PROFILE) return DEFAULT_PROFILE;
  return envAny('USER_DATA_DIR') || DEFAULT_PROFILE;
}

/**
 * Directory for screenshot / HTML / metadata artifacts.
 *
 * Artifacts land next to the CLIENT that asked for them — `./artifacts`
 * under the caller's working directory — so agents working in different
 * projects each get their own output folder. An explicit env override wins.
 *
 * @param {string} [cwd] the requesting client's working directory
 * @returns {string}
 */
function artifactsDir(cwd) {
  const forced = envAny('ARTIFACTS_DIR');
  if (forced) return forced;
  return path.join(cwd || process.cwd(), 'artifacts');
}

/**
 * Create the directory (recursive); no-op if it already exists.
 * @param {string} dir
 * @returns {void}
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------- Chrome / Chromium discovery -----------------------------------

/**
 * Cross-platform Chrome / Chromium executable probe.
 *
 * Precedence:
 *   1. $NATIVEWRIGHT_CHROME_PATH (explicit override)
 *   2. First existing path from a platform-specific candidate list.
 *   3. `null` — caller should let Patchright handle discovery via `channel`.
 *
 * @returns {string|null}
 */
function chromeExecutable() {
  const forced = envAny('CHROME_PATH');
  if (forced) return forced;

  const home = os.homedir();
  let candidates;

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe',
    ];
  } else if (process.platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
  } else {
    // linux / freebsd
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
      '/opt/google/chrome/chrome',
      '/opt/google/chrome/google-chrome',
      '/snap/bin/chromium',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
  }

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

// ---------- lockfile / install.json IO ------------------------------------

/**
 * @typedef {Object} Lockfile
 * @property {number} pid
 * @property {number} port
 * @property {string} userDataDir
 * @property {string} startedAt  ISO 8601 timestamp
 * @property {string} scriptPath absolute path to browser.js
 * @property {string} [node]     `process.version` of the daemon process
 */

/**
 * Read the current daemon lockfile, or `null` if missing.
 * @returns {Promise<Lockfile|null>}
 */
async function readLockfile() {
  try {
    const raw = await fsp.readFile(LOCK_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Write the daemon lockfile.
 * @param {Lockfile} obj
 * @returns {Promise<void>}
 */
async function writeLockfile(obj) {
  ensureDir(ROOT_DIR);
  await fsp.writeFile(LOCK_FILE, JSON.stringify(obj, null, 2));
}

/**
 * Remove the lockfile; silent if absent.
 * @returns {Promise<void>}
 */
async function deleteLockfile() {
  try { await fsp.unlink(LOCK_FILE); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** Is this script part of an INSTALLED package: a `node_modules` segment in its real path? (A checkout and `npm link` are not.) */
function isInstalledScript(scriptPath) {
  let real;
  try { real = fs.realpathSync(scriptPath); } catch { real = path.resolve(String(scriptPath)); }
  return real.split(/[\\/]+/).includes('node_modules');
}

/** The install pointer as stored, or null when it is missing, unreadable or not an object. */
async function readInstallFile(file = INSTALL_FILE) {
  try {
    const o = JSON.parse(await fsp.readFile(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

/**
 * Persist the daemon's absolute script path so downstream tools (Claude Code skills, other agents) can find the entry
 * point when `nativewright` is not on their PATH. The pointer belongs to the INSTALLED package, so it is written only when
 *   (a) there is no (readable) pointer, or
 *   (b) the existing pointer's scriptPath no longer exists on disk, or
 *   (c) the running script is an installed package (its real path has a `node_modules` segment).
 * A start from anywhere else - a git checkout, `npm link` included - never replaces a valid pointer to another path (once, a
 * single start from a clone redirected another tool to unreleased working-tree code on the user's real profile); it may
 * create one when none exists. One log line says when it declines.
 * `file` and `log` are for tests (the default is <data root>/install.json and the daemon log).
 * @param {string} scriptPath
 * @returns {Promise<{written: boolean, reason: string, kept?: string}>}
 */
async function writeInstallFile(scriptPath, { file = INSTALL_FILE, log = appendLog } = {}) {
  const existing = await readInstallFile(file);
  const current = existing && typeof existing.scriptPath === 'string' && existing.scriptPath ? existing.scriptPath : null;
  let reason = null;
  if (!current) reason = 'no pointer yet';
  else if (!fs.existsSync(current)) reason = 'the existing pointer is dangling';
  else if (isInstalledScript(scriptPath)) reason = 'installed package';
  if (!reason) {
    if (path.resolve(current) === path.resolve(scriptPath)) return { written: false, kept: current, reason: 'already points here' };
    log(`install pointer kept: ${current} (this start, ${scriptPath}, is not an installed package)`);
    return { written: false, kept: current, reason: 'valid pointer to another path' };
  }
  ensureDir(path.dirname(file));
  const obj = {
    scriptPath,
    installedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
  };
  await fsp.writeFile(file, JSON.stringify(obj, null, 2));
  return { written: true, reason };
}

// ---------- liveness check ------------------------------------------------

/**
 * Check whether a PID is still alive without sending a real signal.
 * Cross-platform: POSIX uses `kill(pid, 0)`, Windows uses the same
 * Node wrapper which returns EPERM for existing processes we can't signal.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/**
 * Issue a short `GET /ping` to the loopback port and return whether
 * a 200 response came back within `timeoutMs`.
 * @param {number} port
 * @param {number} [timeoutMs=500]
 * @returns {Promise<boolean>}
 */
function httpPing(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/ping', method: 'GET', timeout: timeoutMs,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Return true only when the lockfile's PID is still alive AND the
 * recorded HTTP port accepts a ping. Both checks guard against stale
 * lockfiles left behind by crashes.
 * @param {Lockfile|null} lock
 * @returns {Promise<boolean>}
 */
async function verifyLockfile(lock) {
  if (!lock) return false;
  if (!pidAlive(lock.pid)) return false;
  if (!lock.port) return false;
  return httpPing(lock.port);
}

// ---------- misc ----------------------------------------------------------

/**
 * Build a filesystem-safe artifact name from a user-supplied label.
 * @param {string} [name]
 * @returns {string}
 */
function makeArtifactName(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe  = (name || 'shot').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `${stamp}-${safe}`;
}

/**
 * Append a single line to the daemon log. Never throws.
 * @param {string} line
 * @returns {void}
 */
function appendLog(line) {
  try {
    ensureDir(LOG_DIR);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never throw */ }
}

module.exports = {
  PROFILE, BASE_HOME,
  ROOT_DIR, LOCK_FILE, INSTALL_FILE, LOG_DIR, LOG_FILE, DEFAULT_PROFILE, IDLE_EXIT_MS,
  envAny, nativewrightHome, userDataDir, artifactsDir, chromeExecutable, ensureDir,
  readLockfile, writeLockfile, deleteLockfile, writeInstallFile, readInstallFile, isInstalledScript,
  pidAlive, httpPing, verifyLockfile,
  makeArtifactName, appendLog,
};
