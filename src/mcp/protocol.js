'use strict';

/**
 * Minimal Model Context Protocol server over stdio, Node built-ins only.
 *
 * Transport: one JSON-RPC 2.0 message per line on stdin/stdout. stdout carries
 * protocol frames only; all diagnostics go to stderr. Supported surface:
 * initialize, ping, tools/list, tools/call, notifications, and empty responses
 * for resources/prompts so clients that probe them do not error.
 *
 * @module mcp/protocol
 */

const readline = require('readline');

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_BYTES = 8 * 1024 * 1024;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function textContent(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * @param {{
 *   serverInfo: {name:string, version:string},
 *   tools: object[]|(() => object[]),
 *   callTool: (name:string, args:object) => Promise<object>,
 *   log?: (line:string) => void,
 * }} opts
 */
function createProtocol(opts) {
  const log = opts.log || (() => {});
  const inFlight = new Set();
  const cancelled = new Set();
  let closed = false;

  // A client disappearing mid-write must not surface as an uncaught error.
  process.stdout.on('error', (e) => {
    if (e && e.code !== 'EPIPE') log(`stdout error: ${e.message}`);
    closed = true;
  });

  const tools = () => (typeof opts.tools === 'function' ? opts.tools() : opts.tools);

  function send(message) {
    if (closed) return;
    try {
      process.stdout.write(JSON.stringify(message) + '\n');
    } catch (e) {
      log(`stdout write failed: ${e.message}`);
      closed = true;
    }
  }

  function toolByName(name) {
    return tools().find((t) => t.name === name) || null;
  }

  async function handleRequest(message) {
    const { id, method, params } = message;

    if (method === 'initialize') {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: opts.serverInfo,
      });
    }

    if (method === 'ping') return rpcResult(id, {});

    if (method === 'server/discover') {
      return rpcResult(id, {
        protocolVersions: SUPPORTED_VERSIONS.slice(),
        serverInfo: opts.serverInfo,
      });
    }

    if (method === 'tools/list') return rpcResult(id, { tools: tools() });

    if (method === 'tools/call') {
      if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
        return rpcError(id, INVALID_PARAMS, 'tools/call requires a string "name"');
      }
      const args = params.arguments == null ? {} : params.arguments;
      if (typeof args !== 'object' || Array.isArray(args)) {
        return rpcError(id, INVALID_PARAMS, 'tools/call "arguments" must be an object');
      }
      if (!toolByName(params.name)) {
        return rpcResult(id, textContent(`Unknown tool: ${params.name}`));
      }
      try {
        const result = await opts.callTool(params.name, args);
        if (cancelled.delete(id)) return null;
        return rpcResult(id, result);
      } catch (e) {
        if (cancelled.delete(id)) return null;
        const hint = /unknown command:/i.test(e.message)
          ? '\nthe running daemon may be an older NativeWright; stop it (if no other agent is using it) or use a separate --profile'
          : '';
        return rpcResult(id, textContent('### Error\n' + (e && e.message ? e.message : String(e)) + hint));
      }
    }

    // Advertised capabilities are tools-only, but tolerate probes gracefully.
    if (method === 'resources/list') return rpcResult(id, { resources: [] });
    if (method === 'resources/templates/list') return rpcResult(id, { resourceTemplates: [] });
    if (method === 'prompts/list') return rpcResult(id, { prompts: [] });
    if (method === 'logging/setLevel') return rpcResult(id, {});
    if (method === 'shutdown') return rpcResult(id, {});

    return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  function handleNotification(message) {
    const { method, params } = message;
    if (method === 'notifications/cancelled' && params && params.requestId !== undefined) {
      cancelled.add(params.requestId);
      // Bound the set: a cancel racing a completed request would leak its id.
      while (cancelled.size > 1000) cancelled.delete(cancelled.values().next().value);
    }
    // notifications/initialized, roots/list_changed, progress: nothing to do.
  }

  async function handleOne(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, INVALID_REQUEST, 'Invalid Request');
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message.id, INVALID_REQUEST, 'Invalid Request: expected jsonrpc "2.0" and a method');
    }
    if (message.id === undefined || message.id === null) {
      handleNotification(message);
      return null;
    }
    return handleRequest(message);
  }

  async function handleParsed(parsed) {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return [rpcError(null, INVALID_REQUEST, 'Empty batch')];
      const responses = [];
      for (const item of parsed) {
        const response = await handleOne(item);
        if (response) responses.push(response);
      }
      return responses.length ? responses : null;
    }
    return handleOne(parsed);
  }

  /** Handle one raw line. Returns a promise so tests can await it. */
  function handleLine(line) {
    if (closed) return Promise.resolve();
    const work = (async () => {
      if (typeof line !== 'string') return;
      const trimmed = line.trim();
      if (!trimmed) return;
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_LINE_BYTES) {
        send(rpcError(null, PARSE_ERROR, `message too large (limit ${MAX_LINE_BYTES} bytes)`));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(trimmed); }
      catch (e) {
        send(rpcError(null, PARSE_ERROR, `Parse error: ${e.message}`));
        return;
      }
      try {
        const isBatch = Array.isArray(parsed);
        const response = await handleParsed(parsed);
        if (isBatch) {
          if (Array.isArray(response) && response.length) send(response);
        } else if (response) {
          send(response);
        }
      } catch (e) {
        log(`internal error: ${e.message}`);
        send(rpcError(parsed && parsed.id !== undefined ? parsed.id : null, INTERNAL_ERROR, 'Internal error'));
      }
    })();
    inFlight.add(work);
    work.finally(() => inFlight.delete(work));
    return work;
  }

  /** Attach to a readable stream (stdin) and start serving. */
  function listen(stream) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => { void handleLine(line); });
    rl.on('close', () => { closed = true; });
    return rl;
  }

  /** Wait for in-flight requests, capped at `ms`. */
  async function drain(ms) {
    if (inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled(Array.from(inFlight)),
      sleep(ms),
    ]);
  }

  function close() { closed = true; }

  return { handleLine, listen, drain, close, SUPPORTED_VERSIONS };
}

module.exports = { createProtocol, SUPPORTED_VERSIONS };
