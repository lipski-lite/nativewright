'use strict';

/**
 * Thin HTTP client for the daemon. Used by the one-shot CLI mode
 * (`nativewright <cmd> ...`) and by REPL mode.
 *
 * Every request carries the caller's working directory so artifacts land
 * next to the caller, and a `--page=<id>` (or the NATIVEWRIGHT_PAGE env
 * pin) so the daemon binds the command to exactly one page.
 *
 * @module cli
 */

const http = require('http');
const readline = require('readline');
const cfg = require('./config');

// Friendly command syntax translator: turns positional tokens into an args
// object. Example: `goto https://example.com` → {cmd:'goto', args:{url:'...'}}
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
  new:          [],
  close:        [],
  'close-page': [],
  pages:        [],
};

// Parses `--key=value` and `--flag` into an object; rest are positional.
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

function buildCommand(cmd, rest, flags) {
  const args = { ...flags };
  const positional = POSITIONAL[cmd] || [];
  for (let i = 0; i < positional.length && i < rest.length; i++) {
    args[positional[i]] = rest[i];
  }
  // anything after consumed positionals is joined back (useful for `type` text with spaces)
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

// A client may pin its page once via env (NATIVEWRIGHT_PAGE / PATCHRIGHT_PAGE)
// instead of repeating --page on every call. An explicit --page always wins.
function applyDefaultPage(args) {
  if (args.page != null && args.page !== '') return args;
  const env = cfg.envAny('PAGE');
  if (env) args.page = env;
  return args;
}

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

async function ensureDaemonReachable() {
  const lock = await cfg.readLockfile();
  if (!lock) {
    throw new Error(
      'daemon not running — start it first (best run via a background-capable shell):\n' +
      '  nativewright start\n' +
      'then block until it is listening:\n' +
      '  nativewright wait-ready'
    );
  }
  const alive = await cfg.verifyLockfile(lock);
  if (!alive) {
    throw new Error(
      'daemon lockfile present but process not responding (stale lockfile).\n' +
      '`start` reaps it automatically:\n' +
      '  nativewright start'
    );
  }
  return lock;
}

async function runOneShot(cmd, rawArgs) {
  const { args: flags, rest } = parseTokens(rawArgs);
  const { cmd: outCmd, args } = buildCommand(cmd, rest, flags);
  applyDefaultPage(args);
  const lock = await ensureDaemonReachable();
  const { status, body } = await post(lock.port, '/cmd', { cmd: outCmd, args, cwd: process.cwd() });
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  if (status >= 400 || !body || body.ok === false) process.exit(1);
}

async function runRepl() {
  const lock = await ensureDaemonReachable();
  let usePage = cfg.envAny('PAGE') || null;   // REPL-local default page
  process.stdout.write(
    `nativewright REPL connected pid=${lock.pid} port=${lock.port}\n` +
    `type \`help\` for commands, \`use <page-id>\` to pin a page (\`use\` alone clears), \`quit\` or Ctrl+C to exit\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = () => rl.setPrompt(usePage ? `nativewright[${usePage}]> ` : 'nativewright> ');
  prompt();
  rl.prompt();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    if (trimmed === 'quit' || trimmed === 'exit') { rl.close(); return; }
    const tokens = tokenize(trimmed);
    const cmd = tokens.shift();
    if (cmd === 'use') {
      usePage = tokens[0] || null;
      process.stdout.write(usePage ? `pinned page ${usePage}\n` : 'page pin cleared\n');
      prompt(); rl.prompt(); return;
    }
    const { args: flags, rest } = parseTokens(tokens);
    const { cmd: outCmd, args } = buildCommand(cmd, rest, flags);
    if ((args.page == null || args.page === '') && usePage) args.page = usePage;
    try {
      const { body } = await post(lock.port, '/cmd', { cmd: outCmd, args, cwd: process.cwd() });
      process.stdout.write(JSON.stringify(body, null, 2) + '\n');
      if (outCmd === 'new' && body && body.ok && body.result && body.result.page && !usePage) {
        usePage = body.result.page;
        process.stdout.write(`(pinned new page ${usePage} for this REPL; \`use\` to clear)\n`);
        prompt();
      }
      if ((outCmd === 'close' || outCmd === 'close-page') && body && body.ok && usePage && args.page === usePage) {
        usePage = null;
        prompt();
      }
    } catch (e) {
      process.stdout.write(`(repl error) ${e.message}\n`);
    }
    rl.prompt();
  });
  rl.on('close', () => { process.stdout.write('\nrepl closed\n'); process.exit(0); });
}

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

async function runStop(flags = {}) {
  const lock = await cfg.readLockfile();
  if (!lock) { process.stdout.write('no daemon running (no lockfile)\n'); return; }
  const alive = await cfg.verifyLockfile(lock);
  if (!alive) {
    await cfg.deleteLockfile();
    process.stdout.write('stale lockfile removed\n');
    return;
  }
  try {
    const { body } = await post(lock.port, '/shutdown', { force: !!flags.force });
    if (body && body.ok === false) {
      process.stdout.write(`stop refused: ${body.error}\n`);
      process.exit(1);
    }
    // Wait up to 5s for the pid to exit (the browser flushes the profile on close)
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (!cfg.pidAlive(lock.pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await cfg.deleteLockfile();
    process.stdout.write(`stopped pid=${lock.pid}${body && body.forced ? ' (forced)' : ''}\n`);
  } catch (e) {
    process.stdout.write(`shutdown request failed: ${e.message}\n`);
    process.exit(1);
  }
}

async function runStatus(flags) {
  const lock = await cfg.readLockfile();
  if (!lock) { process.stdout.write(JSON.stringify({ running: false }, null, 2) + '\n'); return; }
  const alive = await cfg.verifyLockfile(lock);
  if (!alive) {
    process.stdout.write(JSON.stringify({ running: false, stale: true, lock }, null, 2) + '\n');
    return;
  }
  const base = { running: true, pid: lock.pid, port: lock.port, userDataDir: lock.userDataDir, startedAt: lock.startedAt };
  try {
    const { body } = await post(lock.port, '/cmd', { cmd: 'state', args: {}, cwd: process.cwd() });
    const st = body && body.result ? body.result : null;
    if (flags && flags.verbose) {
      process.stdout.write(JSON.stringify({ ...base, state: st }, null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify({
        ...base,
        pageCount: st ? st.pageCount : null,
        pages: st ? st.pages.map((p) => ({ page: p.page, label: p.label, url: p.url })) : null,
      }, null, 2) + '\n');
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ ...base, stateError: e.message }, null, 2) + '\n');
  }
}

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
