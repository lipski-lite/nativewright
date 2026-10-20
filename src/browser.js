#!/usr/bin/env node
'use strict';

/**
 * Entry point: dispatches argv to the daemon or the CLI client.
 *
 * Modes:
 *   start                 launch persistent Chrome + HTTP RPC server (long-lived).
 *   stop [--force]        ask the daemon to exit (refuses while pages are open unless forced).
 *   status [--verbose]    print daemon state (open pages, idle timer, recent commands).
 *   wait-ready [--timeout N]  block until the daemon is listening.
 *   repl                  interactive readline loop connected to the daemon.
 *   <cmd> [args]          send a single command to the daemon and print JSON.
 *
 * All commands exit non-zero on failure so shell-tool callers can detect
 * errors without parsing output.
 *
 * @module browser
 */

const path = require('path');
const SCRIPT_PATH = path.resolve(__filename);

// `--profile=<name>` selects a named profile (a separate browser identity with
// its own daemon). It must be applied to the environment BEFORE ./config is
// loaded, because config derives every path from it at require time. It is
// stripped from the argv so it never reaches the daemon as a command arg.
function applyProfileFlag(argv) {
  const out = [];
  for (const t of argv) {
    const m = /^--profile=(.*)$/.exec(t);
    if (m) process.env.NATIVEWRIGHT_PROFILE = m[1];
    else out.push(t);
  }
  return out;
}

async function main() {
  const [, , mode, ...rest] = applyProfileFlag(process.argv);
  if (!mode || mode === 'help' || mode === '--help' || mode === '-h') {
    printHelp();
    return;
  }

  if (mode === 'start') {
    const { runDaemon } = require('./daemon');
    await runDaemon({ scriptPath: SCRIPT_PATH });
    return; // runDaemon never resolves (server stays up until shutdown)
  }

  const cli = require('./cli');

  if (mode === 'stop')      return cli.runStop(parseFlags(rest));
  if (mode === 'status')    return cli.runStatus(parseFlags(rest));
  if (mode === 'wait-ready')return cli.runWaitReady(parseFlags(rest));
  if (mode === 'repl')      return cli.runRepl();

  // Everything else is treated as a one-shot command passed to the daemon.
  return cli.runOneShot(mode, rest);
}

function parseFlags(tokens) {
  const out = {};
  for (const t of tokens) {
    if (t.startsWith('--')) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) out[body.slice(0, eq)] = body.slice(eq + 1);
      else out[body] = true;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`
NativeWright — agent-drivable Patchright browser daemon

USAGE
  nativewright start                          launch persistent Chrome + RPC server
  nativewright stop [--force]                 shut down cleanly (refuses while pages are open unless forced)
  nativewright status [--verbose]             is it running? which pages are open?
  nativewright wait-ready [--timeout=N]       block until server listening
  nativewright repl                           interactive REPL (\`use <id>\` pins a page)
  nativewright <cmd> [args…] [--flag=val]     one-shot command

PROFILES — separate browser identities, each with its own daemon
  --profile=<name>                 put on ANY command (start, status, new, goto, stop, …) to act on
                                   a named profile instead of the default one. A named profile has
                                   its own Chrome profile, cookies, extensions and lockfile under
                                   <data root>/profiles/<name>/. Env: NATIVEWRIGHT_PROFILE.

PAGES — every client gets its own page in its own window
  new [--label=name]               open a page in a NEW WINDOW; returns its stable id (p1, p2, …)
  pages                            list open pages (id, label, url, window)
  close --page=<id>                close your page when done (lease released)
  --page=<id>                      target a page. Required whenever more than one page is open —
                                   ambiguous targeting is refused, never guessed. A lone page
                                   needs no --page. NATIVEWRIGHT_PAGE=<id> pins a default for a shell.

COMMON ONE-SHOT COMMANDS (all take --page=<id>)
  goto <url>                       navigate (with human-behavior post-load idle)
  text [selector]                  inner text of element (or page body)
  click <selector>                 human mouse path + jitter + timing
                                   [--at=x,y] [--hold=ms] [--modifiers=Control,Shift] [--button=] [--clickCount=]
  dblclick <selector>              double-click (a real detail:2 + dblclick event)
  rightclick <selector>            right-click (context menu)
  fill <selector> <value>          human field-clear + typing with real cadence
  type <selector> <text>           human keystroke cadence with per-key dwell   [--typos=on|off|auto]
  press <key>                      Enter, a, Control+A, Control+Shift+ArrowLeft   [--hold=ms] [--repeat=n]
  hover <selector>                 human mouse path to element   [--at=x,y]
  select <selector> <value>        native <select>: real click + arrow keys + Enter (multiple: click / Ctrl-click)
  scroll <dir|px>                  up|down|left|right|top|bottom|<px> [--dx=px] [--target=sel | --x= --y=]
                                   quantised wheel on the scroll CONTAINER under the pointer (inner panels too)
  eval <js>                        evaluate an expression in the page
  eval-file <path>                 evaluate a whole JS file in the page (one evaluate)
  shot [name]                      screenshot → ./artifacts/ of the CALLER's cwd
                                   [--scale=device|css] [--selector=sel] [--fullPage]; returns dpr, imageSize, clip
  save-artifact [name]             screenshot + html + metadata bundle (metadata has the real viewport + dpr)
  state                            daemon snapshot (pages, idle timer, recent commands)
  help                             list all commands

COORDINATES, DRAG, KEYS (see README "Coordinates, drag and keys")
  --space=css|screenshot           css (default) = clientX/clientY; screenshot = device px of a \`shot\` image (css = px / dpr)
  element-at <x> <y>               read-only hit test: tag, id, text, box, cursor, draggable, editable, selectorHint, iframe chain
  click-at <x> <y>                 click a viewport point  [--button= --clickCount= --hold=ms --modifiers= --exact]
  hover-at <x> <y>                 move the pointer to a viewport point
  drag <from> <to>                 drag between elements  [--from-at=x,y --to-at=x,y --button= --modifiers=]
  drag-at <x1> <y1> <x2> <y2>      drag between viewport points
                                   (HTML5 drag-and-drop vs pointer drags are routed automatically)
  mouse-down|mouse-up [--button=]  press / release at the pointer; the hold persists across commands
  key-down <key> | key-up <key>    hold / release a key (Shift, Control, Alt, Meta, Enter, ArrowDown, a, ...)
  release                          release every mouse button and key this page holds
  type-focused <text>              human typing into whatever is focused (no click)
  paste <selector> <text>          REAL clipboard paste (human Ctrl+V; OS clipboard restored)   [--from-file=path]
  paste-focused <text>             same, into the focused field
  drop-files <selector> <path>...  drop OS files onto an element as if dragged from the file manager   [--at=x,y]
  calibrate-wheel [--seconds=10]   record YOUR mouse wheel (human in the loop) so scrolling matches your device
                                   (only a human calibration is adopted; state/status report wheelModel default|human)
  tap <selector> | tap-at <x> <y> | swipe <x1> <y1> <x2> <y2> | pinch <x> <y> --scale=f
                                   touch gestures; REFUSED unless the daemon runs with NATIVEWRIGHT_TOUCH=1.
                                   That daemon is touch-only: click/hover/drag/scroll/fill/type/select/paste <selector>
                                   (all mouse input, --raw too) are refused there; use tap + type-focused, swipe, drop-files
  pages / state                    list input.pointer and input.held (buttons, keys) per page

HUMAN-BEHAVIOR LAYER
  All interaction commands use realistic human-like timing and trajectories
  by default. Add --raw=true for plain Playwright behavior (faster, robotic).
    click .submit --raw=true --page=p1
    fill "#user" alice --raw=true --page=p1
  Pass --seed=<n> for reproducible randomness while debugging.

LIFECYCLE
  Pages are leases. Close yours when done. With no pages open for
  NATIVEWRIGHT_IDLE_EXIT_MS (default 10 min; 0 = never) the daemon exits
  gracefully, flushing cookies/session to the profile. One daemon serves one
  profile; separate identities use separate NATIVEWRIGHT_HOME roots.

ENVIRONMENT
  NATIVEWRIGHT_HOME             override per-user data root
  NATIVEWRIGHT_USER_DATA_DIR    override persistent profile path
  NATIVEWRIGHT_CHROME_PATH      override browser executable path
  NATIVEWRIGHT_ARTIFACTS_DIR    force one artifacts directory (default: caller's ./artifacts)
  NATIVEWRIGHT_PAGE             default --page for this shell
  NATIVEWRIGHT_PROFILE          named profile for this shell (same as --profile=<name>)
  NATIVEWRIGHT_IDLE_EXIT_MS     idle exit delay after the last page closes (default 600000; 0 = never)
  NATIVEWRIGHT_CHANNEL          'chrome' (default) | 'chromium' | 'msedge' | 'chrome-beta'
  NATIVEWRIGHT_HEADLESS         set to 1 to run without a visible window (CI only)
  NATIVEWRIGHT_NO_EXEC_PATH     set to 1 to skip the local Chrome probe (lets Patchright resolve)
  NATIVEWRIGHT_TOUCH            set to 1 for a touch-capable (touch-only, tablet-like) browser: enables tap / swipe / pinch and
                                refuses mouse commands
  NATIVEWRIGHT_LAYOUT_SWITCH    alt+shift (default) | ctrl+shift: the shortcut used when typing switches EN <-> RU
  NATIVEWRIGHT_ALLOW_NO_SANDBOX set to 1 to keep --no-sandbox (needed on root Linux / Docker; default: stripped)
  (each is also accepted with the legacy PATCHRIGHT_ prefix)

DATA ROOT
  Windows   %LOCALAPPDATA%\\NativeWright\\
  macOS     ~/Library/Application Support/NativeWright/
  Linux/BSD $\{XDG_DATA_HOME:-~/.local/share\}/nativewright/
  (profile/default, daemon.json, logs/daemon.log, install.json live here)

See docs: https://github.com/lipski-lite/nativewright

`);
}

main().catch((e) => {
  process.stderr.write(`${e && e.message ? e.message : String(e)}\n`);
  process.exit(1);
});
