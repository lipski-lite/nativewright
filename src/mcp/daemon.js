'use strict';

/**
 * Daemon client for the MCP server.
 *
 * The MCP server does not own a browser: it talks to the same long-lived
 * NativeWright daemon as the CLI. It starts the daemon on demand (detached),
 * sends commands over the loopback RPC, and holds one session page lease.
 * On shutdown it closes that page but never stops the daemon — other agents
 * may share it.
 *
 * @module mcp/daemon
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../config');

const BROWSER_SCRIPT = path.join(__dirname, '..', 'browser.js');
const START_TIMEOUT_MS = 30000;
const POLL_MS = 200;

/** A daemon-side command failure (HTTP 200 with ok:false, or HTTP >= 400). */
class DaemonError extends Error {
  constructor(message, body) {
    super(message);
    this.name = 'DaemonError';
    this.body = body || null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the lockfile, treating an unreadable/corrupt one as absent. */
async function readLockSafe() {
  try { return await cfg.readLockfile(); } catch { return null; }
}

/**
 * POST JSON to the loopback daemon.
 * @param {number} port
 * @param {string} pathname
 * @param {object} payload
 * @param {number} [timeoutMs]
 * @returns {Promise<{status:number, body:object}>}
 */
function postJson(port, pathname, payload, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, body: { ok: false, error: 'bad json', raw: text } }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('daemon request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let ensuring = null;

/**
 * Ensure a live daemon exists for the selected profile, starting one detached
 * if necessary. Single-flight: concurrent tool calls share one startup.
 * @param {string|null} profile
 * @returns {Promise<object>} lockfile
 */
function ensureDaemon(profile) {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    let lock = await readLockSafe();
    if (lock && await cfg.verifyLockfile(lock)) return lock;

    // A stale lockfile is reaped by `start` itself.
    const args = [BROWSER_SCRIPT, 'start'];
    if (profile) args.push('--profile=' + profile);
    const env = Object.assign({}, process.env);
    if (profile) env.NATIVEWRIGHT_PROFILE = profile;
    const child = spawn(process.execPath, args, {
      detached: true, stdio: 'ignore', env, windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      lock = await readLockSafe();
      if (lock && await cfg.verifyLockfile(lock)) return lock;
      await sleep(POLL_MS);
    }
    throw new Error(
      `daemon did not become ready within ${START_TIMEOUT_MS} ms\n` +
      `  browser binary: ${cfg.chromeExecutable() || '(Patchright default)'}\n` +
      `  daemon log: ${cfg.LOG_FILE}\n` +
      'check that the browser binary exists and is executable'
    );
  })().finally(() => { ensuring = null; });
  return ensuring;
}

/**
 * Send a command to the daemon, starting it if needed.
 * Retries once only when the connection was refused before delivery.
 * @param {string} cmd
 * @param {object} args
 * @param {{profile:string|null, cwd:string, timeoutMs:number}} opts
 * @returns {Promise<object>} `{ok,page,result}`
 */
async function callDaemon(cmd, args, opts) {
  const timeoutMs = (opts.timeoutMs || 30000) + 5000;
  let lock = await ensureDaemon(opts.profile);
  let res;
  try {
    res = await postJson(lock.port, '/cmd', { cmd, args, cwd: opts.cwd }, timeoutMs);
  } catch (e) {
    if (e && e.code === 'ECONNREFUSED') {
      // Nothing was delivered; a restart is safe.
      lock = await ensureDaemon(opts.profile);
      res = await postJson(lock.port, '/cmd', { cmd, args, cwd: opts.cwd }, timeoutMs);
    } else {
      throw e;
    }
  }
  const { status, body } = res;
  if (status >= 400 || !body || body.ok === false) {
    throw new DaemonError((body && body.error) || `daemon returned HTTP ${status}`, body);
  }
  return body;
}

/**
 * Session page lease manager.
 * @param {{label:string|null, profile:string|null, cwd:string, timeoutMs:number}} opts
 */
function createSession(opts) {
  let page = null;
  let creating = null;
  const owned = new Set();

  async function ensurePage() {
    if (page) return page;
    if (creating) return creating;
    creating = (async () => {
      const label = opts.label || `mcp-${process.pid}`;
      const body = await callDaemon('new', { label }, opts);
      page = body.result.page;
      owned.add(page);
      return page;
    })().finally(() => { creating = null; });
    return creating;
  }

  function setPage(id) { page = id || null; }
  function getPage() { return page; }
  function own(id) { if (id) owned.add(id); }
  function disown(id) { owned.delete(id); }
  function isOwned(id) { return id != null && owned.has(id); }
  function ownedIds() { return Array.from(owned); }

  async function closePage() {
    const ids = Array.from(owned);
    owned.clear();
    page = null;
    if (ids.length === 0) return;
    // Best effort WITHOUT auto-starting a daemon: if the daemon is gone there
    // is nothing to close, and a shutdown must not spawn Chrome.
    const lock = await readLockSafe();
    if (!lock || !(await cfg.verifyLockfile(lock))) return;
    for (const id of ids) {
      try {
        await postJson(lock.port, '/cmd', { cmd: 'close', args: { page: id }, cwd: opts.cwd }, 3000);
      } catch { /* the page may already be gone */ }
    }
  }

  return { ensurePage, closePage, setPage, getPage, own, disown, isOwned, ownedIds };
}

module.exports = { postJson, ensureDaemon, callDaemon, createSession, DaemonError };
