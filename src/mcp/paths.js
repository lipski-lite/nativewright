'use strict';

/**
 * Filesystem path rules for the MCP server.
 *
 * The MCP server is agent-driven, so file-taking tools resolve paths against a
 * workspace root and reject anything that escapes it. Symlinks are resolved
 * before the containment check; `--allow-unrestricted-file-access` (or the
 * config equivalent) disables the restriction for trusted setups.
 *
 * This is defense-in-depth for upload paths, not a security boundary: there is
 * an unavoidable local TOCTOU between the check here and the daemon's later
 * read, and navigation/eval are unrestricted by design.
 *
 * @module mcp/paths
 */

const fs = require('fs');
const path = require('path');

/** Resolve to the real path when the file exists, else to an absolute path. */
function realpathOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Resolve and validate the workspace root.
 * @param {string} [dir] directory (defaults to process.cwd())
 * @returns {string} absolute real path
 */
function resolveWorkspace(dir) {
  const abs = path.resolve(dir || process.cwd());
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`workspace does not exist: ${abs}`); }
  if (!st.isDirectory()) throw new Error(`workspace is not a directory: ${abs}`);
  return realpathOrResolve(abs);
}

/** True when `candidate` is inside `root` (or equal to it). */
function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * Resolve a user-supplied file path and enforce workspace containment.
 * @param {string} candidate path, absolute or relative to the workspace
 * @param {string} workspace resolved workspace root
 * @param {{allowUnrestricted?: boolean}} [opts]
 * @returns {string} absolute real path
 */
function resolveFile(candidate, workspace, opts = {}) {
  if (typeof candidate !== 'string' || candidate === '') throw new Error('file path required');
  const abs = path.resolve(workspace, candidate);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`file not found: ${abs}`); }
  if (!st.isFile()) throw new Error(`not a file: ${abs}`);
  const real = realpathOrResolve(abs);
  if (!opts.allowUnrestricted && !isInside(workspace, real)) {
    throw new Error(
      `path outside the workspace is not allowed: ${real}\n` +
      'start the MCP server with --allow-unrestricted-file-access to permit it'
    );
  }
  return real;
}

module.exports = { resolveWorkspace, resolveFile, isInside, realpathOrResolve };
