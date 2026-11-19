'use strict';

/**
 * Protocol-level tests for `nativewright-mcp`. No browser and no daemon:
 * these only exercise JSON-RPC framing, discovery, validation, and shutdown.
 *
 * Run: node --test test/mcp.protocol.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP = path.join(__dirname, '..', 'src', 'mcp.js');
const CHROME = process.env.NATIVEWRIGHT_CHROME_PATH || '';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mcp-proto-'));
}

function cleanEnv(home) {
  const env = Object.assign({}, process.env);
  const keep = {};
  for (const k of ['NATIVEWRIGHT_HEADLESS', 'NATIVEWRIGHT_CHANNEL', 'NATIVEWRIGHT_NO_EXEC_PATH',
    'NATIVEWRIGHT_ALLOW_NO_SANDBOX', 'NATIVEWRIGHT_CHROME_PATH']) {
    if (process.env[k] !== undefined) keep[k] = process.env[k];
  }
  for (const k of Object.keys(env)) {
    if (/^(NATIVEWRIGHT|PATCHRIGHT)_/.test(k)) delete env[k];
  }
  Object.assign(env, keep);
  env.NATIVEWRIGHT_HOME = home;
  env.NATIVEWRIGHT_USER_DATA_DIR = path.join(home, 'profile', 'default');
  env.NATIVEWRIGHT_ARTIFACTS_DIR = path.join(home, 'artifacts');
  env.NATIVEWRIGHT_MCP_CONFIG = path.join(home, 'mcp.json');
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  if (!env.NATIVEWRIGHT_CHROME_PATH && !env.NATIVEWRIGHT_NO_EXEC_PATH && CHROME && fs.existsSync(CHROME)) {
    env.NATIVEWRIGHT_CHROME_PATH = CHROME;
  }
  return env;
}

class Client {
  constructor(home) {
    this.proc = spawn(process.execPath, [MCP, '--workspace=' + home], {
      env: cleanEnv(home),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 0;
    this.buffer = '';
    this.badLines = [];
    this.messages = [];
    this.waiters = [];
    this.stderr = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => { this.stderr += chunk; });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { this.badLines.push(line); continue; }
      this.messages.push(msg);
      this._flush(msg);
    }
  }

  _flush(msg) {
    const i = this.waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  }

  waitFor(pred, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`timed out waiting for a message; got ${JSON.stringify(this.messages)}; bad lines ${JSON.stringify(this.badLines)}; stderr ${this.stderr}`));
        }, timeout),
      };
      this.waiters.push(w);
    });
  }

  sendRaw(line) {
    this.proc.stdin.write(line + '\n');
  }

  request(method, params) {
    const id = ++this.nextId;
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.waitFor((m) => m && !Array.isArray(m) && m.id === id);
  }

  async initialize(protocolVersion = '2025-06-18') {
    const res = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'mcp-protocol-test', version: '0' },
    });
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    return res;
  }

  async close() {
    if (this.proc.exitCode !== null) return this.proc.exitCode;
    const exited = new Promise((resolve) => this.proc.once('exit', (code) => resolve(code === null ? -1 : code)));
    this.proc.stdin.end();
    const timer = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    const code = await exited;
    clearTimeout(timer);
    return code;
  }
}

test('initialize negotiates the protocol version and announces nativewright', async (t) => {
  const home = tempHome();
  const client = new Client(home);
  t.after(() => client.close());

  const res = await client.initialize('2025-06-18');
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.equal(res.result.serverInfo.name, 'nativewright');
  assert.equal(typeof res.result.serverInfo.version, 'string');
  assert.ok(res.result.capabilities.tools);
  assert.deepEqual(client.badLines, []);
});

test('initialize falls back to the newest supported version', async (t) => {
  const home = tempHome();
  const client = new Client(home);
  t.after(() => client.close());

  const res = await client.initialize('1999-01-01');
  assert.equal(res.result.protocolVersion, '2025-11-25');
});

test('tools/list returns 26 well-formed, unique tools', async (t) => {
  const home = tempHome();
  const client = new Client(home);
  t.after(() => client.close());

  await client.initialize();
  const res = await client.request('tools/list', {});
  const tools = res.result.tools;
  assert.equal(tools.length, 26);
  const names = new Set();
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.inputSchema.properties, 'object');
    assert.ok(Array.isArray(tool.inputSchema.required));
    assert.ok(!names.has(tool.name), `duplicate tool ${tool.name}`);
    names.add(tool.name);
  }
  for (const expected of [
    'browser_navigate', 'browser_click', 'browser_type', 'browser_take_screenshot',
    'browser_read', 'browser_evaluate', 'browser_tabs', 'browser_wait_for',
    'browser_console_messages', 'browser_network_requests', 'browser_file_upload',
  ]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
});

test('ping, unknown method, and parse errors use the right JSON-RPC errors', async (t) => {
  const home = tempHome();
  const client = new Client(home);
  t.after(() => client.close());

  await client.initialize();
  const ping = await client.request('ping', {});
  assert.deepEqual(ping.result, {});

  const unknown = await client.request('definitely/not/a/method', {});
  assert.equal(unknown.error.code, -32601);

  client.sendRaw('{not json');
  const parse = await client.waitFor((m) => m && !Array.isArray(m) && m.error && m.error.code === -32700);
  assert.equal(parse.id, null);
  assert.deepEqual(client.badLines, []);
});

test('tools/call validation: missing name, unknown tool, missing arguments', async (t) => {
  const home = tempHome();
  const client = new Client(home);
  t.after(() => client.close());

  await client.initialize();

  const noName = await client.request('tools/call', { arguments: {} });
  assert.equal(noName.error.code, -32602);

  const unknown = await client.request('tools/call', { name: 'browser_nope', arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /Unknown tool/);

  const badArgs = await client.request('tools/call', { name: 'browser_navigate', arguments: {} });
  assert.equal(badArgs.result.isError, true);
  assert.match(badArgs.result.content[0].text, /missing required "url"/);

  const badFields = await client.request('tools/call', {
    name: 'browser_fill_form',
    arguments: { fields: [{ value: 'x' }] },
  });
  assert.equal(badFields.result.isError, true);
  assert.match(badFields.result.content[0].text, /fields\[0\].*missing required "target"/);

  const badN = await client.request('tools/call', {
    name: 'browser_downloads',
    arguments: { n: 0 },
  });
  assert.equal(badN.result.isError, true);
  assert.match(badN.result.content[0].text, /must be >= 1/);

  const emptyPaths = await client.request('tools/call', {
    name: 'browser_file_upload',
    arguments: { target: '#f', paths: [] },
  });
  assert.equal(emptyPaths.result.isError, true);
  assert.match(emptyPaths.result.content[0].text, /at least 1 item/);
});

test('unknown --key=value options are rejected', () => {
  const home = tempHome();
  const r = spawnSync(process.execPath, [MCP, '--workspace=' + home, '--bogus-typo=1'], {
    env: cleanEnv(home),
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option: --bogus-typo/);
});

test('a corrupt daemon.json is treated as absent', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'daemon.json'), '{broken');
  const configPath = path.join(__dirname, '..', 'src', 'config.js');
  const script = `const c=require(${JSON.stringify(configPath)});c.readLockfile().then((v)=>process.stdout.write(String(v)))`;
  const r = spawnSync(process.execPath, ['-e', script], { env: cleanEnv(home), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'null');
});

test('batch requests return one response each, notifications omitted', async (t) => {
  const home = tempHome();
  const client = new Client(home);
  t.after(() => client.close());

  await client.initialize();
  client.sendRaw(JSON.stringify([
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'ping' },
  ]));
  const batch = await client.waitFor((m) => Array.isArray(m));
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((r) => r.id).sort(), ['a', 'b']);
});

test('stdin close exits 0 without creating a daemon', async (t) => {
  const home = tempHome();
  const client = new Client(home);
  await client.initialize();
  const code = await client.close();
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(home, 'daemon.json')), false);
});
