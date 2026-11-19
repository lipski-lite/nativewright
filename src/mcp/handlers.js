'use strict';

/**
 * Tool dispatch for the MCP server: validates arguments, maps each tool to a
 * daemon command, and formats the result (text JSON, plus inline images for
 * screenshots).
 *
 * @module mcp/handlers
 */

const fs = require('fs');
const fsp = fs.promises;
const cfg = require('../config');
const daemon = require('./daemon');
const paths = require('./paths');
const { getTools } = require('./tools');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const TYPING_TIMEOUT_MS = 120000;   // humanized typing can exceed the 30 s default

function asNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Basic JSON-schema type check for one property (handles oneOf). */
function typeOk(spec, value) {
  if (!spec) return true;
  if (spec.oneOf) return spec.oneOf.some((s) => typeOk(s, value));
  switch (spec.type) {
    case 'string': return typeof value === 'string';
    case 'number': return asNumber(value) !== undefined;
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value) && (!spec.items || value.every((v) => typeOk(spec.items, v)));
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/**
 * Validate tool arguments against a tool's JSON schema: required fields,
 * types, enums, numeric bounds, array lengths, and one level of array-of-object
 * item validation.
 * @param {object} tool tool definition from tools.js
 * @param {object} args tool arguments (mutated only by numeric coercion)
 */
function validate(tool, args) {
  const errors = [];
  const schema = tool.inputSchema || {};
  for (const req of schema.required || []) {
    const v = args[req];
    if (v === undefined || v === null || v === '') errors.push(`missing required "${req}"`);
  }
  for (const [k, spec] of Object.entries(schema.properties || {})) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    if (!typeOk(spec, v)) { errors.push(`"${k}" must be ${spec.type || 'valid'}`); continue; }
    if (spec.enum && !spec.enum.includes(v)) errors.push(`"${k}" must be one of: ${spec.enum.join(', ')}`);
    if (spec.type === 'number') {
      const n = asNumber(v);
      if (spec.minimum !== undefined && n < spec.minimum) errors.push(`"${k}" must be >= ${spec.minimum}`);
      if (spec.maximum !== undefined && n > spec.maximum) errors.push(`"${k}" must be <= ${spec.maximum}`);
    }
    if (spec.type === 'array' && spec.minItems !== undefined && v.length < spec.minItems) {
      errors.push(`"${k}" must contain at least ${spec.minItems} item(s)`);
    }
    // One level of array-of-object validation (browser_fill_form fields).
    if (Array.isArray(v) && spec.items && spec.items.type === 'object') {
      v.forEach((item, idx) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`"${k}[${idx}]" must be an object`);
          return;
        }
        for (const req of spec.items.required || []) {
          if (item[req] === undefined || item[req] === null || item[req] === '') {
            errors.push(`"${k}[${idx}]" missing required "${req}"`);
          }
        }
        for (const [ik, ispec] of Object.entries(spec.items.properties || {})) {
          const iv = item[ik];
          if (iv === undefined || iv === null) continue;
          if (!typeOk(ispec, iv)) errors.push(`"${k}[${idx}].${ik}" must be ${ispec.type || 'valid'}`);
          else if (ispec.enum && !ispec.enum.includes(iv)) {
            errors.push(`"${k}[${idx}].${ik}" must be one of: ${ispec.enum.join(', ')}`);
          }
        }
      });
    }
  }
  if (errors.length) throw new Error(`Invalid arguments for ${tool.name}:\n- ${errors.join('\n- ')}`);
  // Coerce numeric strings in place (MCP clients occasionally send "1000").
  for (const [k, spec] of Object.entries(schema.properties || {})) {
    if (spec.type === 'number' && typeof args[k] === 'string') {
      const n = asNumber(args[k]);
      if (n !== undefined) args[k] = n;
    }
  }
}

const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

/**
 * Build a text content block from a JSON object. Oversized payloads are
 * replaced by a valid JSON envelope with a bounded `head` string, so clients
 * can always parse the text block.
 * @param {object} obj
 * @returns {{content: object[]}}
 */
function contentObject(obj) {
  let text;
  try { text = JSON.stringify(obj, null, 2); }
  catch { text = JSON.stringify({ error: 'unserializable result' }); }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_TEXT_BYTES) return { content: [{ type: 'text', text }] };
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        truncated: true,
        bytes,
        limit: MAX_TEXT_BYTES,
        head: text.slice(0, 200 * 1024),
      }, null, 2),
    }],
  };
}

/**
 * Build the tool dispatcher.
 * @param {{session:object, config:object, workspace:string, log:Function}} opts
 * @returns {{callTool: Function, log: Function}}
 */
function create(opts) {
  const { session, config, workspace, log } = opts;
  const byName = new Map(getTools(config).map((t) => [t.name, t]));

  const callOpts = (args, minTimeout) => {
    const requested = asNumber(args.timeout);
    let timeoutMs = requested !== undefined ? requested : config.timeoutMs;
    if (minTimeout) timeoutMs = Math.max(timeoutMs, minTimeout);
    return { profile: config.profile, cwd: workspace, timeoutMs };
  };

  async function call(cmd, args, { page = true, minTimeout } = {}) {
    const o = callOpts(args, minTimeout);
    // Only an implicitly assigned session page may be re-created on a stale-id
    // error; an explicit caller-supplied id must fail loudly.
    const implicit = page && args.page == null;
    if (page && implicit) args.page = await session.ensurePage();
    args.timeout = o.timeoutMs;
    try {
      return await daemon.callDaemon(cmd, args, o);
    } catch (e) {
      if (page && implicit && /no page '[^']+'/.test(e.message || '')) {
        session.setPage(null);
        args.page = await session.ensurePage();
        return daemon.callDaemon(cmd, args, o);
      }
      throw e;
    }
  }

  const result = (body, extra) => contentObject(
    Object.assign({ page: body.page == null ? null : body.page, result: body.result }, extra || {})
  );

  const modifiers = (v) => (Array.isArray(v) && v.length ? v.join(',') : undefined);

  /** Daemon args carrying the tool-level explicit page when one was supplied. */
  const argsFor = (toolArgs, base) => {
    const out = Object.assign({}, base);
    if (toolArgs && toolArgs.page != null) out.page = toolArgs.page;
    return out;
  };

  function assertOwned(id, verb) {
    if (!id || session.isOwned(id) || config.allowSharedPages) return;
    throw new Error(
      `${verb} refused: page ${id} was opened by another client\n` +
      'start the MCP server with --allow-shared-pages to operate on pages it did not open'
    );
  }

  const handlers = {
    async browser_navigate(args) {
      return result(await call('goto', argsFor(args, { url: args.url, waitUntil: args.waitUntil })));
    },

    async browser_navigate_back(args) {
      return result(await call('back', argsFor(args, {})));
    },

    async browser_reload(args) {
      return result(await call('reload', argsFor(args, {})));
    },

    async browser_click(args) {
      const a = argsFor(args, { selector: args.target });
      if (args.button) a.button = args.button;
      if (args.clickCount != null) a.clickCount = args.clickCount;
      const mods = modifiers(args.modifiers);
      if (mods) a.modifiers = mods;
      if (args.holdMs != null) a.hold = args.holdMs;
      return result(await call('click', a));
    },

    async browser_type(args) {
      const a = argsFor(args, { text: args.text });
      if (args.typos) a.typos = args.typos;
      let body;
      if (args.target) body = await call('type', Object.assign({ selector: args.target }, a), { minTimeout: TYPING_TIMEOUT_MS });
      else body = await call('type-focused', a, { minTimeout: TYPING_TIMEOUT_MS });
      let pressed = null;
      if (args.submit) pressed = await call('press', argsFor(args, { key: 'Enter' }));
      return result(body, pressed ? { submit: pressed.result } : {});
    },

    async browser_fill_form(args) {
      const done = [];
      let reportPage = args.page || session.getPage();
      for (const f of args.fields) {
        const kind = f.kind || 'text';
        if (kind === 'checkbox' || kind === 'radio') {
          if (truthy(f.value)) {
            const b = await call('click', argsFor(args, { selector: f.target }));
            done.push({ target: f.target, kind, clicked: true, result: b.result });
            if (b.page) reportPage = b.page;
          } else {
            done.push({ target: f.target, kind, skipped: 'false value; checkbox/radio not clicked' });
          }
        } else {
          const b = await call('fill', argsFor(args, {
            selector: f.target,
            value: f.value == null ? '' : String(f.value),
          }), { minTimeout: TYPING_TIMEOUT_MS });
          done.push({ target: f.target, kind, result: b.result });
          if (b.page) reportPage = b.page;
        }
      }
      return contentObject({ page: reportPage, fields: done });
    },

    async browser_press_key(args) {
      const a = argsFor(args, { key: args.key });
      if (args.holdMs != null) a.hold = args.holdMs;
      if (args.repeat != null) a.repeat = args.repeat;
      return result(await call('press', a));
    },

    async browser_hover(args) {
      return result(await call('hover', argsFor(args, { selector: args.target })));
    },

    async browser_select_option(args) {
      return result(await call('select', argsFor(args, { selector: args.target, value: args.values })));
    },

    async browser_drag(args) {
      return result(await call('drag', argsFor(args, { from: args.startTarget, to: args.endTarget })));
    },

    async browser_scroll(args) {
      const direction = args.pixels != null ? String(args.pixels) : (args.direction || 'down');
      const a = argsFor(args, { direction });
      if (args.target) a.target = args.target;
      return result(await call('scroll', a));
    },

    async browser_evaluate(args) {
      const a = argsFor(args, { js: args.expression });
      if (args.target) a.selector = args.target;
      return result(await call('eval', a, { minTimeout: 60000 }));
    },

    async browser_read(args) {
      const kind = args.kind;
      if (kind === 'title') return result(await call('title', argsFor(args, {})));
      if (kind === 'url') return result(await call('url', argsFor(args, {})));
      const a = argsFor(args, args.target ? { selector: args.target } : {});
      return result(await call(kind === 'html' ? 'html' : 'text', a));
    },

    async browser_element_at(args) {
      const a = argsFor(args, { x: args.x, y: args.y });
      if (args.space) a.space = args.space;
      return result(await call('element-at', a));
    },

    async browser_take_screenshot(args) {
      const a = argsFor(args, {});
      if (args.filename) a.name = args.filename;
      if (args.target) a.selector = args.target;
      if (args.fullPage) a.fullPage = true;
      if (args.scale) a.scale = args.scale;
      const body = await call('shot', a, { minTimeout: 60000 });
      const meta = { page: body.page, result: body.result };
      let imagePart = null;
      const file = body.result && body.result.path;
      if (file && !config.images) {
        meta.image = { omitted: true, reason: 'images disabled' };
      } else if (file) {
        try {
          const st = await fsp.stat(file);
          if (st.size > MAX_IMAGE_BYTES) {
            meta.image = { omitted: true, reason: 'too large', size: st.size, limit: MAX_IMAGE_BYTES };
          } else {
            const data = await fsp.readFile(file);
            imagePart = { type: 'image', data: data.toString('base64'), mimeType: 'image/png' };
          }
        } catch (e) {
          meta.image = { omitted: true, reason: e.message };
        }
      }
      const out = contentObject(meta);
      if (imagePart) out.content.push(imagePart);
      return out;
    },

    async browser_save_artifact(args) {
      const a = argsFor(args, {});
      if (args.name) a.name = args.name;
      if (args.fullPage) a.fullPage = true;
      return result(await call('save-artifact', a));
    },

    async browser_downloads(args) {
      const a = argsFor(args, args.n != null ? { n: args.n } : {});
      return result(await call('downloads', a));
    },

    async browser_console_messages(args) {
      // Fetch the full ring first, then filter, then cap: filtering a truncated
      // tail would hide matches.
      const body = await call('console', argsFor(args, { n: 200 }));
      let messages = (body.result && body.result.messages) || [];
      let filteredBy = null;
      if (args.level) {
        const want = args.level === 'warning' ? 'warn' : args.level;
        messages = messages.filter((m) => (m.type || m.level) === want);
        filteredBy = args.level;
      }
      if (args.n != null) messages = messages.slice(-args.n);
      return result(body, filteredBy ? { messages, filteredBy } : { messages });
    },

    async browser_network_requests(args) {
      const a = argsFor(args, args.n != null ? { n: args.n } : {});
      return result(await call('network-log', a));
    },

    async browser_state(args) {
      const body = await call('state', {}, { page: false });
      const lock = await cfg.readLockfile();
      // The daemon command log records args verbatim for every client (typed
      // text, eval source). Never hand that to an MCP client.
      const state = Object.assign({}, body.result || {});
      delete state.commandLog;
      return contentObject({
        page: null,
        result: state,
        sessionPage: session.getPage(),
        ownedPages: session.ownedIds(),
        lock: lock ? { pid: lock.pid, port: lock.port, profile: lock.profile || 'default', userDataDir: lock.userDataDir } : null,
      });
    },

    async browser_tabs(args) {
      if (args.action === 'list') {
        const body = await call('pages', {}, { page: false });
        const pages = (body.result || []).map((p, i) =>
          Object.assign({ index: i, current: p.page === session.getPage(), owned: session.isOwned(p.page) }, p));
        return result(body, { pages });
      }
      if (args.action === 'new') {
        const body = await call('new', { label: args.label || config.label || undefined }, { page: false });
        const id = body.result.page;
        session.own(id);
        if (!session.getPage()) session.setPage(id);
        let navigated = null;
        if (args.url) navigated = (await call('goto', { url: args.url, page: id }, { page: false })).result;
        return result(body, { page: id, navigated });
      }
      if (args.action === 'close') {
        let id = args.page || session.getPage();
        if (args.index != null) {
          const body = await call('pages', {}, { page: false });
          const p = (body.result || [])[args.index];
          if (!p) throw new Error(`no page at index ${args.index}`);
          id = p.page;
        }
        assertOwned(id, 'close');
        const body = await call('close', id ? { page: id } : {}, { page: false });
        session.disown(id);
        if (!id || id === session.getPage()) session.setPage(null);
        return result(body, { closed: id || body.result.closed });
      }
      // select
      const body = await call('pages', {}, { page: false });
      const idx = args.index != null ? args.index : 0;
      const p = (body.result || [])[idx];
      if (!p) throw new Error(`no page at index ${idx}`);
      assertOwned(p.page, 'select');
      session.setPage(p.page);
      let navigated = null;
      if (args.url) navigated = (await call('goto', { url: args.url, page: p.page }, { page: false })).result;
      return result(body, { page: p.page, navigated });
    },

    async browser_wait_for(args) {
      if (args.textGone != null) {
        return result(await call('wait-for', argsFor(args, { selector: `text=${args.textGone}`, state: 'hidden' })));
      }
      if (args.text != null) {
        return result(await call('wait-for', argsFor(args, { selector: `text=${args.text}` })));
      }
      if (args.time != null) {
        const seconds = Math.max(0, Math.min(30, Number(args.time)));
        return result(await call('wait', argsFor(args, { ms: Math.round(seconds * 1000) })));
      }
      throw new Error('browser_wait_for requires one of: time, text, textGone');
    },

    async browser_handle_dialog(args) {
      return result(await call('dialog', argsFor(args, {
        action: args.accept ? 'accept' : 'dismiss',
        promptText: args.promptText,
      })));
    },

    async browser_file_upload(args) {
      // Resolve and validate every path BEFORE touching the page, then send a
      // single upload command so the selection is set atomically.
      const abs = args.paths.map((p) =>
        paths.resolveFile(p, workspace, { allowUnrestricted: config.allowUnrestrictedFileAccess }));
      const body = await call('upload', argsFor(args, { selector: args.target, paths: abs }));
      return contentObject({
        page: body.page == null ? session.getPage() : body.page,
        selector: body.result.selector,
        files: body.result.files,
      });
    },

    async browser_resize(args) {
      return result(await call('viewport', argsFor(args, { w: args.width, h: args.height, force: true })));
    },

    async browser_close(args) {
      const id = args.page || session.getPage();
      assertOwned(id, 'close');
      const body = await call('close', id ? { page: id } : {}, { page: false });
      session.disown(id);
      if (!id || id === session.getPage()) session.setPage(null);
      return result(body, { closed: id || (body.result && body.result.closed) });
    },
  };

  for (const name of Object.keys(handlers)) {
    if (!byName.has(name)) delete handlers[name];
  }
  for (const name of byName.keys()) {
    if (!handlers[name]) throw new Error(`tool ${name} has no handler`);
  }

  async function callTool(name, args) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    validate(tool, args);
    const handler = handlers[name];
    if (!handler) throw new Error(`Tool not implemented: ${name}`);
    return handler(args);
  }

  return { callTool, log };
}

module.exports = { create, validate, typeOk };
