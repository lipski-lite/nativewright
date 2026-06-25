'use strict';

/**
 * HTTP client for the daemon plus an interactive readline REPL. Used by
 * one-shot CLI mode (`nativewright <cmd> ...`) and by REPL mode.
 *
 * @module cli
 */

const http = require('http');
const readline = require('readline');
const cfg = require('./config');

/**
 * Friendly command syntax translator: positional tokens mapped to
 * argument keys. Anything not listed here is passed straight through
 * as `_extra` or concatenated into the last positional slot.
 */
const POSITIONAL = {
  goto:         ['url'],
  click:        ['selector'],
  dblclick:     ['selector'],
  rightclick:   ['selector'],
  fill:         ['selector', 'value'],
  type:         ['selector', 'text'],
  press:        ['key'],
  hover:        ['selector'],
  select:       ['selector', 'value'],
  upload:       ['selector', 'path'],
  scroll:       ['direction'],
  wait:         ['ms'],
  'wait-for':   ['selector'],
  'wait-for-load': ['state'],
  switch:       ['index'],
  text:         ['selector'],
  html:         ['selector'],
  get:          ['selector', 'attr'],
  count:        ['selector'],
  eval:         ['js'],
  'eval-file':  ['path'],
  cookies:      ['url'],
  frame:        ['name'],
  dialog:       ['action', 'promptText'],
  shot:         ['name'],
  'save-artifact': ['name'],
  console:      ['n'],
  'network-log':['n'],
  viewport:     ['w', 'h'],
};

/**
 * Parse `--key=value` / `--flag` tokens out of the argv tail. Remaining
 * tokens are returned as positional `rest`.
 * @param {string[]} tokens
 * @returns {{args: Object, rest: string[]}}
 */
function parseTokens(tokens) {
  const args = {};
  const rest = [];
  for (const t of tokens) {
    if (t.startsWith('--')) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) args[body.slice(0, eq)] = body.slice(eq + 1);
      else args[body] = true;
    } else {
      rest.push(t);
    }
  }
  return { args, rest };
}

/**
 * Assemble a daemon command from a user-typed fragment.
 * @param {string} cmd
 * @param {string[]} rest
 * @param {Object} flags
 * @returns {{cmd: string, args: Object}}
 */
function buildCommand(cmd, rest, flags) {
  const args = { ...flags };
  const positional = POSITIONAL[cmd] || [];
  for (let i = 0; i < positional.length && i < rest.length; i++) {
    args[positional[i]] = rest[i];
  }
  if (rest.length > positional.length) {
    if (positional.length > 0) {
      const lastKey = positional[positional.length - 1];
      args[lastKey] = rest.slice(positional.length - 1).join(' ');
    } else {
      args._extra = rest.slice(positional.length).join(' ');
    }
  }
  return { cmd, args };
}

/**
 * POST a JSON body to the daemon and resolve with its JSON response.
 * @param {number} port
 * @param {string} path
 * @param {Object} payload
 * @returns {Promise<{status: number, body: Object}>}
 */
function post(port, path, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const s = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(s) }); }
        catch (e) { resolve({ status: res.statusCode, body: { ok: false, error: 'bad json', raw: s } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Verify the daemon is up and respond-ready, or throw with an actionable
 * hint describing how to fix the state.
 * @returns {Promise<import('./config').Lockfile>}
 */
async function ensureDaemonReachable() {
  const lock = await cfg.readLockfile();
  if (!lock) {
    throw new Error(
      'daemon not running — start it first:\n' +
      '  nativewright start   (best run via a background-capable shell)\n' +
      `or check \`${cfg.LOCK_FILE}\` for a stale lockfile.`
    );
  }
  const alive = await cfg.verifyLockfile(lock);
  if (!alive) {
    throw new Error(
      'daemon lockfile present but process not responding (stale lockfile).\n' +
      'remove it and restart:\n' +
      `  rm "${cfg.LOCK_FILE}"\n` +
      '  nativewright start'
    );
  }
  return lock;
}

/**
 * One-shot command: connect, post, print JSON, exit.
 * @param {string} cmd
 * @param {string[]} rawArgs
 * @returns {Promise<void>}
 */
async function runOneShot(cmd, rawArgs) {
  const { args: flags, rest } = parseTokens(rawArgs);
  const { cmd: outCmd, args } = buildCommand(cmd, rest, flags);
  const lock = await ensureDaemonReachable();
  const { status, body } = await post(lock.port, '/cmd', { cmd: outCmd, args });
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  if (status >= 400 || !body || body.ok === false) process.exit(1);
}

/**
 * Interactive readline loop connected to the running daemon.
 * @returns {Promise<void>}
 */
async function runRepl() {
  const lock = await ensureDaemonReachable();
  process.stdout.write(
    `nativewright REPL connected pid=${lock.pid} port=${lock.port}\n` +
    `type \`help\` for commands, \`quit\` or Ctrl+C to exit\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt('nativewright> ');
  rl.prompt();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    if (trimmed === 'quit' || trimmed === 'exit') { rl.close(); return; }
    const tokens = tokenize(trimmed);
    const cmd = tokens.shift();
    const { args: flags, rest } = parseTokens(tokens);
    const { cmd: outCmd, args } = buildCommand(cmd, rest, flags);
    try {
      const { body } = await post(lock.port, '/cmd', { cmd: outCmd, args });
      process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    } catch (e) {
      process.stdout.write(`(repl error) ${e.message}\n`);
    }
    rl.prompt();
  });
  rl.on('close', () => { process.stdout.write('\nrepl closed\n'); process.exit(0); });
}

/**
 * Tokenise a REPL line. Respects single- and double-quoted spans.
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else {
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === ' ' || c === '\t') {
        if (cur !== '') { out.push(cur); cur = ''; }
      } else cur += c;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/**
 * Send `/shutdown`, wait for the PID to exit, delete the lockfile.
 * @returns {Promise<void>}
 */
async function runStop() {
  const lock = await cfg.readLockfile();
  if (!lock) { process.stdout.write('no daemon running (no lockfile)\n'); return; }
  const alive = await cfg.verifyLockfile(lock);
  if (!alive) {
    await cfg.deleteLockfile();
    process.stdout.write('stale lockfile removed\n');
    return;
  }
  try {
    await post(lock.port, '/shutdown', {});
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (!cfg.pidAlive(lock.pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await cfg.deleteLockfile();
    process.stdout.write(`stopped pid=${lock.pid}\n`);
  } catch (e) {
    process.stdout.write(`shutdown request failed: ${e.message}\n`);
    process.exit(1);
  }
}

/**
 * Print `{running, pid, port, ...}` JSON. Optionally dumps the full
 * session snapshot when `--verbose` is passed.
 * @param {Object} flags
 * @returns {Promise<void>}
 */
async function runStatus(flags) {
  const lock = await cfg.readLockfile();
  if (!lock) { process.stdout.write(JSON.stringify({ running: false }, null, 2) + '\n'); return; }
  const alive = await cfg.verifyLockfile(lock);
  if (!alive) {
    process.stdout.write(JSON.stringify({ running: false, stale: true, lock }, null, 2) + '\n');
    return;
  }
  const base = { running: true, pid: lock.pid, port: lock.port, userDataDir: lock.userDataDir, startedAt: lock.startedAt };
  if (flags.verbose) {
    try {
      const { body } = await post(lock.port, '/cmd', { cmd: 'state', args: {} });
      process.stdout.write(JSON.stringify({ ...base, state: body.result }, null, 2) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({ ...base, stateError: e.message }, null, 2) + '\n');
    }
    return;
  }
  process.stdout.write(JSON.stringify(base, null, 2) + '\n');
}

/**
 * Block until the daemon is ready or the timeout elapses. Exits 1 on
 * timeout, 0 on success.
 * @param {Object} flags
 * @returns {Promise<void>}
 */
async function runWaitReady(flags) {
  const timeoutMs = Number(flags.timeout) || 30000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await cfg.readLockfile();
    if (lock && await cfg.verifyLockfile(lock)) {
      process.stdout.write(JSON.stringify({ ready: true, pid: lock.pid, port: lock.port }, null, 2) + '\n');
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stdout.write(JSON.stringify({ ready: false, timeoutMs }, null, 2) + '\n');
  process.exit(1);
}

module.exports = { runOneShot, runRepl, runStop, runStatus, runWaitReady };
