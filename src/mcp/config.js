'use strict';

/**
 * Flag / config-file / environment handling for `nativewright-mcp`.
 *
 * Deliberately imports no core module: the entry point must set
 * NATIVEWRIGHT_PROFILE *before* requiring ../config, whose path constants are
 * frozen at require time.
 *
 * Precedence: built-in defaults < config file < environment < CLI flags.
 *
 * @module mcp/config
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const FLAGS_WITH_VALUE = new Set(['profile', 'workspace', 'label', 'timeout', 'config']);
const KNOWN_FLAGS = new Set([
  'profile', 'workspace', 'label', 'timeout', 'config',
  'no-images', 'allow-unrestricted-file-access', 'allow-shared-pages',
  'print-config', 'version', 'help',
]);

const DEFAULTS = {
  profile: null,
  workspace: null,
  label: null,
  timeoutMs: 30000,
  images: true,
  allowUnrestrictedFileAccess: false,
  allowSharedPages: false,
  excludeTools: [],
};

function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'nativewright', 'mcp.json');
}

/** Parse `--key=value`, `--key value`, and bare `--flag`. */
function parseArgv(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-h') { flags.help = true; continue; }
    if (!t.startsWith('--')) throw new Error(`unexpected argument: ${t}`);
    const body = t.slice(2);
    const eq = body.indexOf('=');
    const key = eq >= 0 ? body.slice(0, eq) : body;
    if (!KNOWN_FLAGS.has(key)) throw new Error(`unknown option: --${key}`);
    if (eq >= 0) { flags[key] = body.slice(eq + 1); continue; }
    if (FLAGS_WITH_VALUE.has(body)) {
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { flags[body] = next; i++; }
      else flags[body] = true;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

function readConfigFile(file) {
  if (!file) return {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`cannot read config file ${file}: ${e.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`invalid JSON in config file ${file}: ${e.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config file ${file} must contain a JSON object`);
  }
  return parsed;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function normalize(raw, source) {
  const out = {};
  const o = pick(raw, [
    'profile', 'workspace', 'label', 'timeoutMs', 'timeout',
    'images', 'allowUnrestrictedFileAccess', 'allowSharedPages', 'excludeTools',
  ]);
  if (o.profile !== undefined) out.profile = o.profile === null || o.profile === '' ? null : String(o.profile);
  if (o.workspace !== undefined) out.workspace = o.workspace === null || o.workspace === '' ? null : String(o.workspace);
  if (o.label !== undefined) out.label = o.label === null || o.label === '' ? null : String(o.label);
  const timeout = o.timeoutMs !== undefined ? o.timeoutMs : o.timeout;
  if (timeout !== undefined) {
    const n = Number(timeout);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${source}: timeoutMs must be a non-negative number`);
    out.timeoutMs = n;
  }
  if (o.images !== undefined) {
    if (typeof o.images !== 'boolean') throw new Error(`${source}: images must be a boolean`);
    out.images = o.images;
  }
  if (o.allowUnrestrictedFileAccess !== undefined) {
    if (typeof o.allowUnrestrictedFileAccess !== 'boolean') {
      throw new Error(`${source}: allowUnrestrictedFileAccess must be a boolean`);
    }
    out.allowUnrestrictedFileAccess = o.allowUnrestrictedFileAccess;
  }
  if (o.allowSharedPages !== undefined) {
    if (typeof o.allowSharedPages !== 'boolean') {
      throw new Error(`${source}: allowSharedPages must be a boolean`);
    }
    out.allowSharedPages = o.allowSharedPages;
  }
  if (o.excludeTools !== undefined) {
    if (!Array.isArray(o.excludeTools) || o.excludeTools.some((x) => typeof x !== 'string')) {
      throw new Error(`${source}: excludeTools must be an array of tool names`);
    }
    out.excludeTools = o.excludeTools.slice();
  }
  return out;
}

function envConfig(env = process.env) {
  const raw = {};
  if (env.NATIVEWRIGHT_MCP_PROFILE) raw.profile = env.NATIVEWRIGHT_MCP_PROFILE;
  if (env.NATIVEWRIGHT_MCP_WORKSPACE) raw.workspace = env.NATIVEWRIGHT_MCP_WORKSPACE;
  if (env.NATIVEWRIGHT_MCP_LABEL) raw.label = env.NATIVEWRIGHT_MCP_LABEL;
  if (env.NATIVEWRIGHT_MCP_TIMEOUT_MS) raw.timeoutMs = env.NATIVEWRIGHT_MCP_TIMEOUT_MS;
  if (env.NATIVEWRIGHT_MCP_IMAGES !== undefined) raw.images = !/^(0|false|no)$/i.test(env.NATIVEWRIGHT_MCP_IMAGES);
  if (env.NATIVEWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS !== undefined) {
    raw.allowUnrestrictedFileAccess = /^(1|true|yes)$/i.test(env.NATIVEWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS);
  }
  if (env.NATIVEWRIGHT_MCP_ALLOW_SHARED_PAGES !== undefined) {
    raw.allowSharedPages = /^(1|true|yes)$/i.test(env.NATIVEWRIGHT_MCP_ALLOW_SHARED_PAGES);
  }
  if (env.NATIVEWRIGHT_MCP_EXCLUDE_TOOLS) {
    raw.excludeTools = env.NATIVEWRIGHT_MCP_EXCLUDE_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return normalize(raw, 'environment');
}

function flagConfig(flags) {
  const raw = {};
  if (flags.profile !== undefined) raw.profile = flags.profile === true ? '' : flags.profile;
  if (flags.workspace !== undefined) raw.workspace = flags.workspace === true ? '' : flags.workspace;
  if (flags.label !== undefined) raw.label = flags.label === true ? '' : flags.label;
  if (flags.timeout !== undefined) raw.timeoutMs = flags.timeout === true ? '' : flags.timeout;
  if (flags['no-images']) raw.images = false;
  if (flags['allow-unrestricted-file-access']) raw.allowUnrestrictedFileAccess = true;
  if (flags['allow-shared-pages']) raw.allowSharedPages = true;
  return normalize(raw, 'command line');
}

/**
 * Resolve the effective configuration.
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{config: object, action: null|'help'|'version'|'print-config', configFile: string|null}}
 */
function parse(argv) {
  const flags = parseArgv(argv);
  const action = flags.help ? 'help'
    : flags.version ? 'version'
      : flags['print-config'] ? 'print-config'
        : null;

  const explicit = typeof flags.config === 'string' ? flags.config : null;
  const file = explicit || process.env.NATIVEWRIGHT_MCP_CONFIG || defaultConfigPath();
  const exists = fs.existsSync(file);
  if (explicit && !exists) throw new Error(`config file not found: ${explicit}`);

  const fromFile = exists ? normalize(readConfigFile(file), `config file ${file}`) : {};
  const config = Object.assign(
    {},
    DEFAULTS,
    fromFile,
    envConfig(),
    flagConfig(flags)
  );
  return { config, action, configFile: exists ? file : null };
}

const HELP = `Usage: nativewright-mcp [options]

MCP (stdio) server for NativeWright. Each client gets a page lease on the
shared NativeWright daemon, which is started on demand.

Options:
  --profile=<name>                     named NativeWright profile
  --workspace=<dir>                    workspace root for file access (default: cwd)
  --label=<name>                       session-page label (default: mcp-<pid>)
  --timeout=<ms>                       default tool timeout (default: 30000)
  --no-images                          return screenshot paths only, not image data
  --allow-unrestricted-file-access     permit upload paths outside the workspace
  --allow-shared-pages                 allow selecting/closing pages opened by other clients
  --config=<path>                      config file (default: ~/.config/nativewright/mcp.json)
  --print-config                       print the resolved configuration and exit
  --version                            print the version and exit
  --help                               print this help and exit

Environment:
  NATIVEWRIGHT_MCP_CONFIG, NATIVEWRIGHT_MCP_WORKSPACE, NATIVEWRIGHT_MCP_LABEL,
  NATIVEWRIGHT_MCP_TIMEOUT_MS, NATIVEWRIGHT_MCP_IMAGES,
  NATIVEWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS, NATIVEWRIGHT_MCP_ALLOW_SHARED_PAGES,
  NATIVEWRIGHT_MCP_EXCLUDE_TOOLS
`;

module.exports = { parse, HELP, DEFAULTS, defaultConfigPath, parseArgv };
