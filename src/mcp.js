#!/usr/bin/env node
'use strict';

/**
 * `nativewright-mcp` — MCP (stdio) server for NativeWright.
 *
 * Thin bridge between MCP clients and the shared NativeWright daemon. The
 * daemon is started on demand; each MCP connection holds one page lease; the
 * daemon is never stopped on exit.
 *
 * stdout is reserved for JSON-RPC frames. All diagnostics go to stderr.
 *
 * @module mcp
 */

const mcpConfig = require('./mcp/config');
const paths = require('./mcp/paths');
const pkg = require('../package.json');

function main() {
  let parsed;
  try {
    parsed = mcpConfig.parse(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(2);
  }
  const { config, action } = parsed;

  if (action === 'help') {
    process.stdout.write(mcpConfig.HELP);
    return;
  }
  if (action === 'version') {
    process.stdout.write(pkg.version + '\n');
    return;
  }

  // This must happen BEFORE requiring ./config: its profile paths are frozen
  // at require time (see src/config.js).
  if (config.profile) process.env.NATIVEWRIGHT_PROFILE = config.profile;

  const cfg = require('./config');
  let workspace;
  try {
    workspace = paths.resolveWorkspace(config.workspace || process.cwd());
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(2);
  }

  if (action === 'print-config') {
    process.stdout.write(JSON.stringify({
      profile: cfg.PROFILE,
      workspace,
      label: config.label,
      timeoutMs: config.timeoutMs,
      images: config.images,
      allowUnrestrictedFileAccess: config.allowUnrestrictedFileAccess,
      excludeTools: config.excludeTools,
      lockFile: cfg.LOCK_FILE,
      userDataDir: cfg.userDataDir(),
      logFile: cfg.LOG_FILE,
      configFile: parsed.configFile,
    }, null, 2) + '\n');
    return;
  }

  const daemon = require('./mcp/daemon');
  const { getTools } = require('./mcp/tools');
  const handlers = require('./mcp/handlers');
  const { createProtocol } = require('./mcp/protocol');

  const log = (line) => {
    try { process.stderr.write(`[nativewright-mcp] ${line}\n`); } catch { /* stderr gone */ }
  };

  const session = daemon.createSession({
    label: config.label,
    profile: config.profile,
    cwd: workspace,
    timeoutMs: config.timeoutMs,
  });

  const impl = handlers.create({ session, config, workspace, log });
  const protocol = createProtocol({
    serverInfo: { name: 'nativewright', version: pkg.version },
    tools: () => getTools(config),
    callTool: impl.callTool,
    log,
  });

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    protocol.close();
    await protocol.drain(5000);
    await session.closePage();
    process.exit(0);
  }

  process.stdin.setEncoding('utf8');
  const rl = protocol.listen(process.stdin);
  rl.on('close', () => { void shutdown('stdin closed'); });
  process.stdin.on('end', () => { void shutdown('stdin end'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('uncaughtException', (e) => log(`uncaught exception: ${e && e.message ? e.message : e}`));
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e && e.message ? e.message : e}`));

  log(`ready workspace=${workspace} profile=${cfg.PROFILE || 'default'} tools=${getTools(config).length}`);
}

main();
