'use strict';

/**
 * End-to-end tests for `nativewright-mcp`: a real daemon, a real browser
 * (unless NATIVEWRIGHT_HEADLESS=1), and a local fixture server.
 *
 * Run: node --test test/mcp.integration.test.js
 * Skip-free but slow (browser startup plus humanized input).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP = path.join(__dirname, '..', 'src', 'mcp.js');
const BROWSER = path.join(__dirname, '..', 'src', 'browser.js');
// No local fallback: use the environment's browser, or let Patchright resolve
// the channel (as CI does with NATIVEWRIGHT_NO_EXEC_PATH=1).
const CHROME = process.env.NATIVEWRIGHT_CHROME_PATH || '';

const FIXTURE = `<!doctype html>
<html><head><title>MCP Fixture</title></head>
<body>
  <h1 id="h">Hello MCP</h1>
  <input id="name">
  <button id="inc" onclick="document.getElementById('out').textContent=String(+document.getElementById('out').textContent+1)">inc</button>
  <div id="out">0</div>
  <input type="file" id="file" multiple>
</body></html>`;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanEnv(home) {
  const env = Object.assign({}, process.env);
  // Preserve CI/runtime browser settings before scrubbing the rest.
  const keep = {};
  for (const k of [
    'NATIVEWRIGHT_HEADLESS', 'NATIVEWRIGHT_CHANNEL', 'NATIVEWRIGHT_NO_EXEC_PATH',
    'NATIVEWRIGHT_ALLOW_NO_SANDBOX', 'NATIVEWRIGHT_CHROME_PATH',
  ]) {
    if (process.env[k] !== undefined) keep[k] = process.env[k];
  }
  for (const k of Object.keys(env)) {
    if (/^(NATIVEWRIGHT|PATCHRIGHT)_/.test(k)) delete env[k];
  }
  Object.assign(env, keep);
  env.NATIVEWRIGHT_HOME = home;
  env.NATIVEWRIGHT_USER_DATA_DIR = path.join(home, 'profile', 'default');
  env.NATIVEWRIGHT_ARTIFACTS_DIR = path.join(home, 'artifacts');
  // Never inherit the developer's real MCP config.
  env.NATIVEWRIGHT_MCP_CONFIG = path.join(home, 'mcp.json');
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  if (!env.NATIVEWRIGHT_CHROME_PATH && !env.NATIVEWRIGHT_NO_EXEC_PATH && CHROME && fs.existsSync(CHROME)) {
    env.NATIVEWRIGHT_CHROME_PATH = CHROME;
  }
  env.NATIVEWRIGHT_IDLE_EXIT_MS = '0';           // keep the daemon alive across server exit
  return env;
}

class Client {
  constructor(home, workspace) {
    this.proc = spawn(process.execPath, [MCP, '--workspace=' + workspace], {
      env: cleanEnv(home),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 0;
    this.buffer = '';
    this.messages = [];
    this.waiters = [];
    this.stderr = '';
    this.badLines = [];
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
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  waitFor(pred, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`timed out; got ${JSON.stringify(this.messages)}; stderr ${this.stderr}`));
        }, timeout),
      };
      this.waiters.push(w);
    });
  }

  sendRaw(line) { this.proc.stdin.write(line + '\n'); }

  request(method, params) {
    const id = ++this.nextId;
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.waitFor((m) => m && !Array.isArray(m) && m.id === id);
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-integration-test', version: '0' },
    });
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    return res;
  }

  async callTool(name, args, opts = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    const result = res.result;
    const text = result && result.content ? result.content.find((c) => c.type === 'text') : null;
    const message = text ? text.text : '(no text)';
    if (opts.expectError) {
      assert.equal(result.isError, true, `${name} should have failed`);
      return { result, text: message };
    }
    assert.ok(!result.isError, `${name} failed: ${message}`);
    return { result, text: message, json: JSON.parse(message) };
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

function runStatus(home) {
  const r = spawnSync(process.execPath, [BROWSER, 'status'], { env: cleanEnv(home), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('MCP integration: pages, navigation, input, artifacts, uploads, diagnostics, lifetime', { timeout: 300000 }, async (t) => {
  const home = tempDir('nw-mcp-int-');
  const workspace = path.join(home, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'upload.txt'), 'hello upload');
  fs.writeFileSync(path.join(workspace, 'upload2.txt'), 'second upload');
  const outsideFile = path.join(home, 'outside.txt');
  fs.writeFileSync(outsideFile, 'outside');

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const client = new Client(home, workspace);

  t.after(async () => {
    await client.close();
    spawnSync(process.execPath, [BROWSER, 'stop', '--force'], { env: cleanEnv(home) });
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  await client.initialize();

  // Concurrent first calls must share one lazily-created session page.
  const [readTitle, readUrl] = await Promise.all([
    client.callTool('browser_read', { kind: 'title' }),
    client.callTool('browser_read', { kind: 'url' }),
  ]);
  assert.equal(readTitle.json.page, readUrl.json.page);
  const pageId = readTitle.json.page;
  assert.match(pageId, /^p\d+$/);

  const nav = await client.callTool('browser_navigate', { url });
  assert.equal(nav.json.result.status, 200);
  assert.equal(nav.json.page, pageId);

  const title = await client.callTool('browser_read', { kind: 'title' });
  assert.equal(title.json.result.title, 'MCP Fixture');

  const heading = await client.callTool('browser_read', { kind: 'text', target: '#h' });
  assert.equal(heading.json.result.text, 'Hello MCP');

  const filled = await client.callTool('browser_fill_form', {
    fields: [{ target: '#name', value: 'Alice' }],
  });
  assert.equal(filled.json.fields.length, 1);
  const value = await client.callTool('browser_evaluate', { expression: "document.querySelector('#name').value" });
  assert.equal(value.json.result.value, 'Alice');

  await client.callTool('browser_click', { target: '#inc' });
  const counter = await client.callTool('browser_evaluate', { expression: "document.querySelector('#out').textContent" });
  assert.equal(counter.json.result.value, '1');

  const shot = await client.callTool('browser_take_screenshot', {});
  assert.equal(shot.json.result.dpr > 0, true);
  assert.ok(fs.existsSync(shot.json.result.path), 'screenshot file exists');
  const image = shot.result.content.find((c) => c.type === 'image');
  assert.ok(image, 'screenshot returns an image content block');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 100, 'image payload is non-empty');

  const list1 = await client.callTool('browser_tabs', { action: 'list' });
  assert.equal(list1.json.pages.length, 1);
  assert.equal(list1.json.pages[0].current, true);
  assert.equal(list1.json.pages[0].index, 0);

  const opened = await client.callTool('browser_tabs', { action: 'new', url });
  const secondId = opened.json.page;
  assert.notEqual(secondId, pageId);
  const list2 = await client.callTool('browser_tabs', { action: 'list' });
  assert.equal(list2.json.pages.length, 2);

  await client.callTool('browser_tabs', { action: 'close', index: 1 });
  const list3 = await client.callTool('browser_tabs', { action: 'list' });
  assert.equal(list3.json.pages.length, 1);
  assert.equal(list3.json.pages[0].page, pageId);

  const waited = await client.callTool('browser_wait_for', { text: 'Hello MCP' });
  assert.equal(waited.json.result.state, 'visible');

  const upload = await client.callTool('browser_file_upload', {
    target: '#file',
    paths: ['upload.txt', 'upload2.txt'],
  });
  assert.equal(upload.json.files.length, 2);
  const fileCount = await client.callTool('browser_evaluate', { expression: "document.querySelector('#file').files.length" });
  assert.equal(fileCount.json.result.value, 2, 'both files are set in one upload command');

  const denied = await client.callTool('browser_file_upload', { target: '#file', paths: [outsideFile] }, { expectError: true });
  assert.match(denied.text, /outside the workspace/);

  // Playwright selector support in element-scoped evaluate.
  const tag = await client.callTool('browser_evaluate', {
    target: 'text=Hello MCP',
    expression: 'el => el.tagName',
  });
  assert.equal(tag.json.result.value, 'H1');

  // Console level filtering (warning maps to console.warn).
  await client.callTool('browser_evaluate', {
    expression: "console.warn('warn-marker'); console.error('error-marker'); null",
  });
  const warnRes = await client.callTool('browser_console_messages', { level: 'warning' });
  assert.ok(warnRes.json.messages.some((m) => m.text.includes('warn-marker')));
  assert.ok(warnRes.json.messages.every((m) => m.type === 'warn'));
  const errRes = await client.callTool('browser_console_messages', { level: 'error' });
  assert.ok(errRes.json.messages.some((m) => m.text.includes('error-marker')));

  const network = await client.callTool('browser_network_requests', {});
  assert.ok(Array.isArray(network.json.result.entries));
  assert.ok(network.json.result.entries.length > 0, 'network log captured the fixture request');

  const state = await client.callTool('browser_state', {});
  assert.equal(state.json.sessionPage, pageId);
  assert.ok(state.json.lock && state.json.lock.pid > 0);
  assert.equal(state.json.result.commandLog, undefined, 'the daemon command log is not exposed');

  // An explicit bad page must fail, not silently retarget the action.
  const badPage = await client.callTool('browser_click', { target: '#inc', page: 'p999' }, { expectError: true });
  assert.match(badPage.text, /no page 'p999'/);
  const stateAfterBad = await client.callTool('browser_state', {});
  assert.equal(stateAfterBad.json.sessionPage, pageId, 'the session page is unchanged');
  const counterAfterBad = await client.callTool('browser_evaluate', { expression: "document.querySelector('#out').textContent" });
  assert.equal(counterAfterBad.json.result.value, '1', 'no click was executed anywhere else');

  await client.callTool('browser_close', {});
  const list4 = await client.callTool('browser_tabs', { action: 'list' });
  assert.equal(list4.json.pages.length, 0);

  // Server exit must not stop the daemon.
  const statusBefore = runStatus(home);
  assert.equal(statusBefore.running, true);
  const code = await client.close();
  assert.equal(code, 0);

  const statusAfter = runStatus(home);
  assert.equal(statusAfter.running, true, 'daemon survives MCP server exit');
  assert.equal(statusAfter.pageCount, 0, 'session page lease was released');
  assert.deepEqual(client.badLines, []);
});
