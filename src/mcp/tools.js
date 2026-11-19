'use strict';

/**
 * MCP tool definitions for NativeWright.
 *
 * Names follow the Playwright MCP's `browser_*` convention so the model can
 * transfer intuition, but the semantics are NativeWright's: selectors are
 * Playwright locator strings (CSS, text=, role=, xpath=), there are no ARIA
 * snapshot refs, and every page tool accepts an optional `page` id.
 *
 * @module mcp/tools
 */

const SEL = 'Playwright selector: CSS, text=, role=, or xpath= (NativeWright has no ARIA refs)';
const PAGE = 'page id; defaults to this MCP session page';
const TIMEOUT = { type: 'number', minimum: 0, description: 'timeout in milliseconds (default 30000)' };
const TARGET = { type: 'string', description: 'element ' + SEL };
const SEL_REQUIRED = { type: 'string', description: SEL };

const page = { type: 'string', description: PAGE };
const timeout = TIMEOUT;

function schema(properties, required) {
  return { type: 'object', properties, required: required || [], additionalProperties: false };
}

const READ = { readOnlyHint: true, openWorldHint: false };
const ACTION = { readOnlyHint: false, openWorldHint: false };
const WEB = { readOnlyHint: false, openWorldHint: true };
const ASSERT = { readOnlyHint: true, openWorldHint: false };

const list = [
  {
    name: 'browser_navigate',
    description: 'Navigate the current page to a URL (NativeWright; headed Chrome, persistent profile, human post-load pause).',
    inputSchema: schema({
      url: { type: 'string', description: 'absolute URL to open' },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
      page, timeout,
    }, ['url']),
    annotations: WEB,
  },
  {
    name: 'browser_navigate_back',
    description: 'Go back in the current page history.',
    inputSchema: schema({ page, timeout }),
    annotations: WEB,
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page.',
    inputSchema: schema({ page, timeout }),
    annotations: WEB,
  },
  {
    name: 'browser_click',
    description: 'Click an element. Input is humanized by default (real mouse path and timing).',
    inputSchema: schema({
      target: SEL_REQUIRED,
      button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      clickCount: { type: 'number', minimum: 1, maximum: 3 },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["Control","Shift"]' },
      holdMs: { type: 'number', minimum: 0, maximum: 600000, description: 'hold the button this long' },
      page, timeout,
    }, ['target']),
    annotations: WEB,
  },
  {
    name: 'browser_type',
    description: 'Type text with human cadence. With target: click the field first, then type. Without target: type into the focused element.',
    inputSchema: schema({
      text: { type: 'string' },
      target: TARGET,
      submit: { type: 'boolean', description: 'press Enter after typing' },
      typos: { type: 'string', enum: ['on', 'off', 'auto'], description: 'typo simulation (auto skips password fields)' },
      page, timeout,
    }, ['text']),
    annotations: WEB,
  },
  {
    name: 'browser_fill_form',
    description: 'Fill several fields in order. Text fields use fill (select-all + clear + type). Checkbox/radio fields are clicked when the value is truthy (a plain click toggles, so re-filling an already-checked box unchecks it).',
    inputSchema: schema({
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            target: SEL_REQUIRED,
            value: { type: 'string' },
            kind: { type: 'string', enum: ['text', 'checkbox', 'radio'], default: 'text' },
          },
          required: ['target'],
          additionalProperties: false,
        },
      },
      page, timeout,
    }, ['fields']),
    annotations: WEB,
  },
  {
    name: 'browser_press_key',
    description: 'Press a key or chord (Enter, Tab, ArrowDown, Control+A).',
    inputSchema: schema({
      key: { type: 'string' },
      holdMs: { type: 'number', minimum: 0, maximum: 600000 },
      repeat: { type: 'number', minimum: 1, maximum: 500 },
      page, timeout,
    }, ['key']),
    annotations: ACTION,
  },
  {
    name: 'browser_hover',
    description: 'Move the mouse to an element with a human path.',
    inputSchema: schema({ target: SEL_REQUIRED, page, timeout }, ['target']),
    annotations: WEB,
  },
  {
    name: 'browser_select_option',
    description: 'Select option(s) in a native <select> by value or visible label.',
    inputSchema: schema({
      target: SEL_REQUIRED,
      values: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      page, timeout,
    }, ['target', 'values']),
    annotations: WEB,
  },
  {
    name: 'browser_drag',
    description: 'Drag from one element to another (HTML5 drop vs pointer drag is chosen automatically).',
    inputSchema: schema({
      startTarget: SEL_REQUIRED,
      endTarget: SEL_REQUIRED,
      page, timeout,
    }, ['startTarget', 'endTarget']),
    annotations: WEB,
  },
  {
    name: 'browser_scroll',
    description: 'Scroll with real wheel events on the scroll container under the pointer. Use target to place the pointer over the intended panel.',
    inputSchema: schema({
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
      pixels: { type: 'number', description: 'vertical pixels; overrides direction' },
      target: TARGET,
      page, timeout,
    }),
    annotations: ACTION,
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the page. With target, expression is called as a function with the matched element.',
    inputSchema: schema({
      expression: { type: 'string', description: 'JS expression, IIFE, or function body when target is given' },
      target: TARGET,
      page, timeout,
    }, ['expression']),
    annotations: ACTION,
  },
  {
    name: 'browser_read',
    description: 'Read rendered page content: text, html, title, or url.',
    inputSchema: schema({
      kind: { type: 'string', enum: ['text', 'html', 'title', 'url'] },
      target: TARGET,
      page, timeout,
    }, ['kind']),
    annotations: READ,
  },
  {
    name: 'browser_element_at',
    description: 'Read-only hit test at a viewport point: tag, id, role, name, text, box, selectorHint, iframe chain.',
    inputSchema: schema({
      x: { type: 'number' },
      y: { type: 'number' },
      space: { type: 'string', enum: ['css', 'screenshot'], default: 'css' },
      page, timeout,
    }, ['x', 'y']),
    annotations: READ,
  },
  {
    name: 'browser_take_screenshot',
    description: 'Take a screenshot of the page or an element. Returns the PNG inline unless images are disabled.',
    inputSchema: schema({
      target: TARGET,
      fullPage: { type: 'boolean' },
      scale: { type: 'string', enum: ['device', 'css'] },
      filename: { type: 'string', description: 'artifact name prefix (not a path)' },
      page, timeout,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'browser_save_artifact',
    description: 'Save a PNG + HTML + metadata evidence bundle under <workspace>/artifacts.',
    inputSchema: schema({
      name: { type: 'string' },
      fullPage: { type: 'boolean' },
      page, timeout,
    }),
    annotations: ACTION,
  },
  {
    name: 'browser_downloads',
    description: 'List downloads captured for this page (files are saved under <workspace>/artifacts).',
    inputSchema: schema({
      n: { type: 'number', minimum: 1, maximum: 50 },
      page, timeout,
    }),
    annotations: READ,
  },
  {
    name: 'browser_console_messages',
    description: 'Return recent console messages and page errors for this page.',
    inputSchema: schema({
      level: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'debug', 'log', 'pageerror', 'unhandledrejection'],
        description: 'filter by level (warning maps to console.warn)',
      },
      n: { type: 'number', minimum: 1, maximum: 200 },
      page, timeout,
    }),
    annotations: READ,
  },
  {
    name: 'browser_network_requests',
    description: 'Return recent request/response metadata for this page (no headers or bodies).',
    inputSchema: schema({
      n: { type: 'number', minimum: 1, maximum: 100 },
      page, timeout,
    }),
    annotations: READ,
  },
  {
    name: 'browser_state',
    description: 'Daemon and page state: open pages, held input, idle timer, recent commands.',
    inputSchema: schema({ page, timeout }),
    annotations: READ,
  },
  {
    name: 'browser_tabs',
    description: 'Manage pages (NativeWright opens each page in its own window; there are no tabs). list/new/close/select; select changes the session page. Pages opened by other clients are listed but cannot be selected or closed unless the server allows shared pages.',
    inputSchema: schema({
      action: { type: 'string', enum: ['list', 'new', 'close', 'select'] },
      index: { type: 'number', minimum: 0, description: 'page index for select/close, 0-based' },
      label: { type: 'string', description: 'label for new' },
      url: { type: 'string', description: 'navigate after new/select' },
      page, timeout,
    }, ['action']),
    annotations: ACTION,
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for time (seconds), text to appear, or text to disappear.',
    inputSchema: schema({
      time: { type: 'number', minimum: 0, maximum: 30, description: 'seconds, max 30' },
      text: { type: 'string', description: 'wait until this text is visible' },
      textGone: { type: 'string', description: 'wait until this text is gone' },
      page, timeout,
    }),
    annotations: ASSERT,
  },
  {
    name: 'browser_handle_dialog',
    description: 'Set the page dialog policy before triggering it (default is dismiss).',
    inputSchema: schema({
      accept: { type: 'boolean' },
      promptText: { type: 'string' },
      page, timeout,
    }, ['accept']),
    annotations: ACTION,
  },
  {
    name: 'browser_file_upload',
    description: 'Set files on an <input type=file>. Paths are resolved against the workspace and may not escape it unless the server allows unrestricted access.',
    inputSchema: schema({
      paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
      target: SEL_REQUIRED,
      page, timeout,
    }, ['paths', 'target']),
    annotations: ACTION,
  },
  {
    name: 'browser_resize',
    description: 'Override the viewport size (warning: changes real window geometry).',
    inputSchema: schema({
      width: { type: 'number', minimum: 1 },
      height: { type: 'number', minimum: 1 },
      page, timeout,
    }, ['width', 'height']),
    annotations: ACTION,
  },
  {
    name: 'browser_close',
    description: 'Close a page lease (defaults to the MCP session page).',
    inputSchema: schema({ page, timeout }),
    annotations: ACTION,
  },
];

/**
 * Return the tool list, optionally filtered.
 * @param {{excludeTools?: string[]}} [config]
 */
function getTools(config) {
  const exclude = new Set((config && config.excludeTools) || []);
  return list.filter((t) => !exclude.has(t.name));
}

module.exports = { getTools, list };
