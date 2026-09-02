<div align="center">

# NativeWright

**An agent-drivable browser daemon with a persistent Chrome profile.**
Give Claude Code, Cursor, Codex, and Gemini CLI a real browser they can steer with one-shot CLI calls — without losing login state between turns.

[![npm version](https://img.shields.io/npm/v/nativewright.svg?style=flat-square)](https://www.npmjs.com/package/nativewright)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=flat-square)](LICENSE)
[![ci](https://img.shields.io/github/actions/workflow/status/lipski-lite/nativewright/ci.yml?branch=main&style=flat-square)](https://github.com/lipski-lite/nativewright/actions)
[![node](https://img.shields.io/node/v/nativewright.svg?style=flat-square)](package.json)
[![platforms](https://img.shields.io/badge/platforms-win%20%7C%20macOS%20%7C%20linux-lightgrey.svg?style=flat-square)](#platform-support)

</div>

---

Built on top of [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) — a stealth-patched Playwright fork — NativeWright packages it as a **long-lived localhost daemon** so AI coding agents can drive a real browser from any one-shot shell call. Cookies, localStorage, and device tokens survive every stop/start; the next session opens already logged in.

NativeWright also adds a **built-in human-behavior layer**: every `click`, `type`, `fill`, `hover`, `scroll`, and `press` is routed through realistic timing distributions (log-normal keystroke cadence, Fitts-like movement durations) and trajectories (cubic Bézier paths with per-sample Gaussian jitter, mid-path hesitation, overshoot-and-correct). No extra dependencies — just Patchright's existing `page.mouse.*` and `page.keyboard.*` primitives. Opt out per-call with `--raw=true` when you need robotic precision.

## Why NativeWright exists

AI coding agents (Claude Code, Cursor, Codex, Gemini CLI) run shell commands through a synchronous `exec`-style tool. They can *start* a long-running process, but they **cannot write to its stdin afterwards**. That kills any traditional stdin REPL the moment the first tool call returns.

NativeWright solves this with a tiny HTTP-RPC daemon:
- **Start once.** `nativewright start` launches a stealth-patched Chrome with your persistent profile and opens an ephemeral loopback port.
- **Drive forever.** Each subsequent `nativewright <cmd>` call is a one-shot CLI that posts JSON to the daemon and prints the response — the agent reasons about the output and fires the next command.
- **Sessions persist.** Profile directory survives across daemon restarts. Log in once; agents drive your accounts for days.

```
┌────────────────────────┐        ┌────────────────────────────┐
│  AI coding agent turn  │        │   NativeWright daemon      │
│  (Claude Code / Cursor │─POST──▶│   long-lived on 127.0.0.1  │
│   Codex / Gemini CLI)  │◀─JSON──│   owns 1 Patchright ctx    │
└────────────────────────┘        │   holds the profile lock   │
                                  └──────────────┬─────────────┘
                                                 │ Patchright
                                                 ▼
                                  ┌────────────────────────────┐
                                  │  System Chrome / Chromium  │
                                  │  persistent user-data-dir  │
                                  │  + human-behavior layer    │
                                  └────────────────────────────┘
```

## Use cases

Designed for workflows where **any one of** these five things matters — often all five at once.

### 1. Driving LLM web interfaces from an AI coding agent

Gemini, ChatGPT, Claude.ai, NotebookLM, Perplexity, DeepSeek, Mistral Le Chat — AI products whose most capable modes live in a web UI behind a login, rendered as a heavy JavaScript single-page application. NativeWright gives your agent one persistently-logged-in browser it can drive turn after turn: submit prompts, wait for streaming responses, read results, download generated artifacts. One manual login, then weeks of agent-driven use without re-auth friction.

### 2. Using your own subscription to a generative AI tool via the browser UI instead of the API

Many frontier image / video / audio models ship to end-users first through the **web UI** — Google's **Nano Banana** image generator in Gemini, OpenAI's **GPT Image** (DALL·E 3) in ChatGPT Plus, **Midjourney** on its web interface, **NotebookLM Audio Overviews**, **Suno**, **Runway** — where your paid subscription already includes generous generation quotas. The equivalent API, when it exists, often costs more per call, rate-limits tighter, lags features, or isn't available at all. NativeWright lets your agent use the same subscription you already pay for, through the same browser you already log in to, the same way you'd use it by hand — just automated. Your account, your entitlement, your workflow.

### 3. Integrating your own data from services you're entitled to access

Many SaaS products (analytics dashboards, BI tools, billing portals, internal admin panels, project management suites) don't ship a public API for the subset of your own data you need — or gate it behind enterprise pricing. Driving the UI you already have legitimate access to — exporting a report, triggering a job, pulling your own invoices, reading your own metrics — lets you integrate services that never planned to be integrated. Persistent login + human-like interaction timing makes this practical without writing service-specific glue for every vendor.

### 4. E2E testing with realistic human input timing

A test that fills a form field in 5 ms passes your login flow but misses the race conditions your real users hit every day — when a human types at 60-100 WPM into a React-controlled input, when they tab between fields with real dwell times, when they scroll a page at human velocity instead of teleporting to an offset. NativeWright's human-mode `fill`, `type`, `click`, and `scroll` reproduce the actual timing profile of a human operator (log-normal inter-key intervals, per-key dwell, Fitts-law mouse movements, real wheel physics), surfacing timing-dependent bugs that instant-fill tests hide.

### 5. Long-running agent workflows that span turns, restarts, or days

Profile persistence means the browser session survives `stop`/`start` cycles: agent logs in once, and every subsequent session on the same machine opens already-authenticated. No credential injection, no expiring OAuth tokens to juggle inside the agent, no re-auth friction between agent turns hours apart. Cookies, localStorage, IndexedDB, and device tokens are preserved exactly the way they would be for a human using the same computer.

### Representative tasks

- Generate image assets using your Gemini / Nano Banana or ChatGPT / DALL·E 3 subscription, then download the outputs to disk.
- Drive a web-based design or whiteboard tool where your account holds the canvas state, iterating visual revisions from an agent.
- Export a report from a SaaS dashboard you're subscribed to, on a cadence the product's own API can't match.
- Run recurring back-office flows for your own accounts — triggering jobs, updating settings pages, refreshing caches — where the vendor ships no API but the web UI works fine.
- Run production-like E2E tests against your own staging environment with realistic typing cadence, mouse trajectories, and scroll physics.
- Capture design-regression screenshot bundles at specific viewports after each deploy (PNG + HTML + metadata via `save-artifact`).

## Features

- **Multi-agent by design** — any number of agents share one daemon; each `new` page opens in its own window with a stable id, every command names its page (`--page=<id>`), pages have their own queues and state, and artifacts land in the caller's project. No shared "active page" to clobber. See [Multiple agents at once](#multiple-agents-at-once).
- **Human-behavior layer (enabled by default)** — mouse moves along cubic Bézier paths with Gaussian jitter, mid-path hesitation, and overshoot-and-correct, dispatched as per-frame coalesced pointer samples; keystrokes use log-normal cadence with per-key dwell, explicit Shift handling and optional typo-simulation; scrolls via real `page.mouse.wheel` ticks with edge-detection. Opt out per-call with `--raw=true`. See [Human-behavior layer](#human-behavior-layer) below.
- **Persistent profile** — cookies, localStorage, IndexedDB, and device tokens survive `stop`/`start`. Log into Google once; Gemini / Gmail / Docs stay live for ~2 weeks per Google's token lifetime.
- **Real Chrome by default** — `channel: 'chrome'` for maximum stealth; drops to bundled Chromium for CI (`NATIVEWRIGHT_CHANNEL=chromium`).
- **Stealth preserved** — built on Patchright; no custom UA, no headless by default, no leftover automation flags. Eliminates the detection signals vanilla Playwright emits out of the box, so your own automation of your own accounts looks like normal usage.
- **Ephemeral port binding** — `127.0.0.1:0` avoids conflicts; the chosen port is recorded in a lockfile so CLI calls find the daemon.
- **Stale-lockfile recovery** — a crashed daemon can't block the next start; the `start` command verifies PID + HTTP ping and reaps dead lockfiles.
- **ANSI-clean errors** — Playwright's decorated error messages are stripped to plain JSON so agents can parse failures without escape-code noise.
- **Structured command log** — last 20 commands with timing available via `status --verbose`; full log at `$NATIVEWRIGHT_HOME/logs/daemon.log`.
- **In-page console capture** — Patchright stealth suppresses `page.on('console')`; NativeWright re-injects a hook after every navigation and drains it on demand via the `console` command.
- **Auto-saved downloads** — `page.on('download')` → `dl.saveAs(artifactsDir + name)`; no manual file handling.
- **Three modes in one binary** — `start` (daemon), `<cmd>` (one-shot CLI), `repl` (interactive for humans). Pick per use case.
- **Cross-platform** — Windows, macOS, Linux. Tested in CI on all three.
- **Zero runtime deps except Patchright** — no `express`, no `commander`, no test framework at runtime.

## Human-behavior layer

Modern anti-bot systems don't just fingerprint the browser — they fingerprint the **input stream**. Patchright handles the browser side (WebGL, webdriver flag, Runtime.enable, etc.); NativeWright handles the input side. Every mouse move, click, keystroke, and scroll tick emitted by the daemon passes through a layer that imitates how real humans use a computer.

Enabled **by default** on every interaction command. Zero extra dependencies — everything runs on Patchright's existing `page.mouse.move / down / up / wheel` and `page.keyboard.press` primitives.

Opt out per-call with `--raw=true` when you need robotic precision (invisible elements, programmatic fills, scripted logins where slow typing would itself look suspicious).

### What the layer covers

| Primitive | Humanised behaviour |
|---|---|
| **Mouse paths** | Cubic Bézier trajectories with perpendicular control-point offsets. Per-sample Gaussian jitter. Three easing curves (ease-in-out, ease-out, near-linear) picked per move so detectors can't fingerprint a single velocity profile. |
| **Overshoot & correct** | ~20% of longer moves overshoot the target by 6-24 px, pause, then correct back. Matches how real users fling the cursor. |
| **Mid-path hesitation** | 12% of long moves pause briefly mid-trajectory with micro-jitter — what humans do when the target is non-obvious. |
| **Fitts-law timing** | Move duration grows log-linearly with distance and shrinks with target size (`mean = 80 + 90·log2(d/w + 1)` ms), sampled as log-normal. |
| **Landing distribution** | Never dead-centre. Gaussian around the centre with aspect-aware σ — wide elements have wider X spread (matches where the visible label text is). |
| **Click dwell** | mousedown→mouseup holds 30-180 ms (log-normal, median 70). Settle pause before the button press. |
| **Keystroke cadence** | Per-character base mean (letters fast, digits/punctuation slower, uppercase slower due to Shift hold), log-normal jitter, burstiness, post-space and post-punctuation extra pauses, occasional 200-2200 ms mid-sentence pauses. |
| **Per-key dwell** | Individual key down-up hold times sampled independently; keys don't fire in uniform 50 ms pulses. |
| **Typo simulation** | ~0.8% per char chance of pressing the wrong QWERTY neighbour, noticing, pressing Backspace, correcting. **Auto-disabled** for password / OTP / CVV / secret / token fields (detected by `type=password`, name/id/autocomplete attrs). |
| **Scroll physics** | Real `page.mouse.wheel` ticks with variable magnitude (60-180 px) and log-normal inter-tick gaps. Occasional "reading" pauses. **Edge-detection**: stops when `window.scrollY` doesn't advance for 2 consecutive ticks. |
| **Scroll-to-element** | Wheels naturally toward off-screen elements before interacting (not `scrollIntoViewIfNeeded`, which teleports). |
| **Think-time** | Between actions: three-regime log-normal (15% skip, 60% short 80-900 ms, 20% medium 300-1800 ms, 5% long 700-4500 ms). Prevents detectors from fitting a single distribution to action spacing. |
| **Field clearing** | Triple-click + Ctrl+A + Delete (matches what users actually do) — handles React-controlled inputs and contenteditables that resist programmatic `fill`. |
| **Seeded randomness** | Pass `--seed=<integer>` for reproducible runs. Omit for non-deterministic. |

### Examples

```bash
# Human-like by default
nativewright click "button.submit"
nativewright fill "#email" "alice@example.com"
nativewright type "textarea" "multi-word message with realistic cadence"
nativewright scroll down

# Opt out per call when you need speed or precision
nativewright click ".hidden-toggle" --raw=true
nativewright fill "#api-token" "$TOKEN" --raw=true

# Reproducible runs (same seed → same random choices)
nativewright click ".button" --seed=42
```

### Telemetry

Human-mode `click` returns where the cursor actually landed inside the target:

```json
{
  "ok": true,
  "result": {
    "selector": "button.submit",
    "button": "left",
    "clickCount": 1,
    "landedAt": { "x": 842, "y": 517 },
    "targetBox": { "x": 810, "y": 500, "width": 80, "height": 34 },
    "moveMs": 247,
    "totalMs": 389
  }
}
```

Useful when debugging "my click didn't register" — you see the exact point the mouse reached and the bounding box it was aiming for.

### Testing the layer without a browser

The math is unit-testable in isolation:

```bash
npm run test:sanity
```

Verifies seeded RNG reproducibility, Gaussian mean/SD, log-normal percentiles, path geometry, aspect-aware landing distribution, `charBaseMs` monotonicity, and Fitts-law growth. No browser launched.

## Quick start

```bash
# 1. Install (global is handy; local works too)
npm install -g nativewright

# 2. Install a browser binary patchright can drive
#    → recommended: system Chrome (already installed for most devs)
#    → alternative: bundled Chromium (hermetic, great for CI)
npx patchright install chrome          # or: npx patchright install chromium

# 3. Launch the daemon (run this in a background-capable shell)
nativewright start &
nativewright wait-ready --timeout=30000

# 4. Claim your own page — it opens in its own window and returns a stable id
nativewright new --label=hello           # → {"page":"p1", ...}

# 5. Drive it — one-shot commands, JSON output, each naming the page
nativewright goto https://example.com --page=p1
nativewright text h1 --page=p1
nativewright shot hello --page=p1

# 6. Release the page when the task is done (the daemon idle-exits on its own)
nativewright close --page=p1
```

Without a global install, just prefix with `npx`:

```bash
npx nativewright start &
npx nativewright wait-ready
npx nativewright new --label=hello       # → p1
npx nativewright goto https://example.com --page=p1
```

For humans who want to poke around interactively:

```bash
nativewright repl
# nativewright> new --label=poke          (the REPL pins the new page for you)
# nativewright[p2]> goto https://example.com
# nativewright[p2]> text h1
# nativewright[p2]> shot
# nativewright[p2]> close
# nativewright> quit
```

## Usage with AI coding agents

NativeWright is designed to be driven by agents. The pattern is identical across Claude Code, Cursor, Codex, and Gemini CLI:

1. **Locate the binary** — call the `nativewright` bin directly if it's on PATH; otherwise `install.json` under the data root (`~/.local/share/nativewright/` on Linux, `~/Library/Application Support/NativeWright/` on macOS, `%LOCALAPPDATA%\NativeWright\` on Windows) has a `scriptPath` that resolves to `browser.js`.
2. **Check status** — `nativewright status` → `{running, pid, port, pageCount, pages}`.
3. **Start if needed** — run `nativewright start` in a background-capable shell (`&`, `nohup`, or the agent's `run_in_background` facility), then `wait-ready`.
4. **Claim a page** — `nativewright new --label=<task>` opens a page in its own window and returns a stable id (`p1`, `p2`, …). Remember it.
5. **Drive the page** — each command is a separate shell call carrying `--page=<id>`; the daemon preserves state between them.
6. **Release the page on task completion** — `nativewright close --page=<id>`. Don't `stop` — other agents may be working; the daemon exits gracefully by itself once no pages have been open for the idle period (flushing cookies so the **next** task opens already logged in).

### Multiple agents at once

Any number of agents can share one daemon. There is **no shared "active page"**: every command names its page, and the daemon binds it to that page inside the page's own queue, so concurrent agents can never clobber each other. Page ids are stable and never re-indexed when another page closes; frame scope, dialog policy and console/network buffers are per page; commands on different pages run concurrently. If more than one page is open and you omit `--page`, the daemon **refuses** with a clear error rather than guessing. Each page lives in its own window, so it stays a foreground, `visibilityState: 'visible'` page even when other windows overlap it (background *tabs* would be hidden and throttled). Artifacts are written under the **caller's** working directory, so agents in different projects don't mix files. In a persistent shell you can pin your page once with `NATIVEWRIGHT_PAGE=p3` instead of repeating the flag.

One daemon serves one profile (identity). Distinct identities need distinct profiles → separate `NATIVEWRIGHT_HOME` roots.

### Claude Code

NativeWright ships two ready-to-use skills in `claude-skills/`:

- **`nativewright`** — the main driver skill. Teaches the lifecycle, full command reference, when-to / when-not-to, common pitfalls.
- **`nativewright-login-bootstrap`** — one-off ritual for establishing a persistent login to a new site (Google, Microsoft, GitHub, SaaS). The human logs in by hand in the visible Chrome window; the profile captures the cookies; every future run is automatic.

Copy both directories into `~/.claude/skills/` (user-level) or `<project>/.claude/skills/` (project-level) and they become available to any Claude Code session in that scope.

### Cursor / Codex / Gemini CLI

Install via `npm install -g nativewright` or use `npx`. The three command modes (start / one-shot / repl) map cleanly to any agent's shell-execution tool. See [`docs/agents.md`](docs/agents.md) for agent-specific examples (coming soon).

## Command reference

All page commands accept `--page=<id>` (required whenever more than one page is open; a lone page needs no flag), `--timeout=<ms>` (default 30000) and `--key=value` flags for any non-positional option. All responses are JSON and echo the page they acted on: `{ok: true, page: "p1", result: …}` or `{ok: false, page, error, stack?}`.

**All interaction commands also accept `--raw=true`** to opt out of the human-behavior layer (faster, straight-line mouse paths, no keystroke cadence), and `--seed=<int>` for reproducible randomness.

| Group | Command | Positional | Notes |
|---|---|---|---|
| Pages | `new [--label=name] [--window=false]` | — | opens a page in a **new window**; returns its stable id (`p1`, `p2`, …) |
|  | `pages` | — | lists open pages: id, label, url, windowId, opener, cwd |
|  | `close --page=<id>` | — | closes that page (lease released) |
| Nav | `goto <url>` | url | `--waitUntil=load\|domcontentloaded\|networkidle`; human-mode adds a post-load idle |
|  | `back` / `forward` / `reload` | — |  |
| Interact | `click <selector>` | selector | human Bézier path by default; `--raw=true` for straight-line |
|  | `dblclick <selector>` | selector | double-click (clickCount=2) |
|  | `rightclick <selector>` | selector | right-button click (context menu) |
|  | `fill <selector> <value>` | selector, value | human: select-all + clear (gesture varies) + typed cadence with explicit Shift handling |
|  | `type <selector> <text>` | selector, text | human keystroke cadence; `--typos=on\|off\|auto` (auto disables for password fields) |
|  | `press <key>` | key | e.g. `Enter`, `Control+A`, `ArrowDown`; human-mode adds pre-press hesitation |
|  | `hover <selector>` | selector | human mouse path to element |
|  | `select <selector> <value>` | selector, value | `<select>` option |
|  | `scroll <top\|bottom\|up\|down\|<px>>` | direction | human: real wheel ticks with edge-detection |
|  | `upload <selector> <path>` | selector, path | file input |
| Wait | `wait <ms>` | ms | blind sleep |
|  | `wait-for <selector>` | selector | `--state=visible\|hidden\|attached\|detached` |
|  | `wait-for-load` | — | `--state=load\|domcontentloaded\|networkidle` |
| Read | `text [selector]` | selector? | inner text of element or page body |
|  | `html [selector]` | selector? | outerHTML or full document |
|  | `title` / `url` | — |  |
|  | `get <selector> <attr>` | selector, attr | `getAttribute` |
|  | `count <selector>` | selector | number of matches |
|  | `eval <js>` | js | expression or statements; returns `{value}` |
|  | `eval-file <path>` | path | evaluate a whole JS file in the page in one `evaluate` (path relative to the caller's cwd) |
|  | `cookies [--url=...]` | — | domain-scoped cookie dump (pageless) |
| Frames | `frame <name>` / `frame --reset` | name | scope this page's interactions to a frame |
| Dialogs | `dialog <accept\|dismiss> [prompt]` | action, promptText? | this page's policy for alert/confirm/prompt |
| Artifacts | `shot [name]` | name? | PNG under the caller's `./artifacts/` |
|  | `save-artifact [name]` | name? | PNG + HTML + metadata JSON bundle |
|  | `downloads [--n=N]` | — | this page's captured downloads with auto-saved paths |
| Diagnostics | `console [--n=N]` | — | this page's recent `console.*` messages (re-injected hook) |
|  | `network-log [--n=N]` | — | this page's recent requests/responses |
|  | `state` | — | pages, idle timer, command ring buffer (pageless) |
| Viewport | `viewport <w> <h> --force` | w, h | overrides the real window geometry; requires `--force` |

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `NATIVEWRIGHT_HOME` | per-user data root | platform default (see below) |
| `NATIVEWRIGHT_USER_DATA_DIR` | persistent browser profile path | `<HOME>/profile/default` |
| `NATIVEWRIGHT_ARTIFACTS_DIR` | force one screenshot & bundle output directory | the **caller's** `./artifacts` |
| `NATIVEWRIGHT_PAGE` | default `--page` for a shell (explicit flag wins) | unset |
| `NATIVEWRIGHT_IDLE_EXIT_MS` | graceful exit after the last page has been closed this long; `0` = never | `600000` (10 min) |
| `NATIVEWRIGHT_CHROME_PATH` | explicit browser binary path | auto-detected |
| `NATIVEWRIGHT_CHANNEL` | Patchright channel | `chrome` |
| `NATIVEWRIGHT_HEADLESS` | headless mode (**CI only — breaks stealth**) | `false` |
| `NATIVEWRIGHT_NO_EXEC_PATH` | skip local Chrome probe (let Patchright resolve) | `false` |
| `NATIVEWRIGHT_ALLOW_NO_SANDBOX` | keep `--no-sandbox` in Chrome args (needed on root Linux / Docker) | `false` on Windows/macOS/non-root Linux; auto-true on root Linux |

**Per-user data root defaults:**
- Windows — `%LOCALAPPDATA%\NativeWright\`
- macOS — `~/Library/Application Support/NativeWright/`
- Linux/BSD — `${XDG_DATA_HOME:-~/.local/share}/nativewright/`

## Platform support

| Platform | Status | Notes |
|---|---|---|
| Windows 10 / 11 | ✅ Tested in CI | PowerShell + Git Bash both work |
| macOS 13+ | ✅ Tested in CI | Apple Silicon + Intel |
| Ubuntu 22.04 / 24.04 | ✅ Tested in CI | other distros should work; file an issue if not |

## Stealth notes

NativeWright inherits Patchright's stealth patches out of the box. The defaults preserve them. If you override these, stealth degrades:

- **Don't set a custom `userAgent`** — breaks the UA-consistency check.
- **Don't force `headless: true`** — modern headless is detectable; the `NATIVEWRIGHT_HEADLESS` env var exists for CI smoke tests only.
- **Don't use `viewport: {w, h}`** — Patchright defaults to the OS-reported viewport; fixed dimensions flag automation. The `viewport` command refuses to change the size unless you pass `--force=true`.
- **Don't add `--disable-blink-features`** — Patchright already sets the right flag.
- **`--no-sandbox` is stripped by default.** Patchright's default args include it, but it's a well-known bot-telltale fingerprinted by modern anti-bot systems (DataDome, PerimeterX, Cloudflare bot-manager) — and it triggers Chrome's yellow "unsupported flag" warning bar in every window. NativeWright removes it via `ignoreDefaultArgs` on Windows / macOS / non-root Linux. It's kept on **root Linux / Docker** because without it Chromium refuses to start with "No usable sandbox!". Set `NATIVEWRIGHT_ALLOW_NO_SANDBOX=1` to force-keep it.

### About the yellow "unsupported flag" warning bar

New Chrome versions show a yellow warning bar in the tab strip for the flag `--disable-blink-features=AutomationControlled`. **This is expected and will not be removed.** Here's why:

- Patchright uses this flag as its **sole mechanism for hiding `navigator.webdriver`**. Without it, `navigator.webdriver === true` — the single most trivial bot-detection check, present in virtually every anti-bot system on the web.
- Empirically tested: stripping the flag makes `webdriver` visible again. There is no JS-level workaround Patchright uses in parallel — the flag IS the stealth.
- The warning bar is visible **only to the human looking at the browser window**. It lives in browser chrome (infobar area), not in page DOM. JavaScript running on any visited page **cannot detect it**. Anti-bot scripts see the same clean page they would otherwise.
- The bar can be dismissed by clicking the × — harmless, but it reappears on next browser launch.

In other words: the warning is a cosmetic annoyance for the human operator, not a stealth regression. Keeping the flag is the correct trade-off for a stealth-focused tool.

For a complete list of stealth invariants, see the upstream [Patchright docs](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright).

## Architecture

```
src/
├── browser.js        entry; argv dispatch (start | stop | status | wait-ready | repl | <cmd>)
├── daemon.js         HTTP server, BrowserContext, page registry, event wiring
├── commands.js       command handlers (goto / click / shot / …)
├── cli.js            HTTP client for one-shot + REPL modes
├── config.js         env, paths, lockfile I/O, Chrome detection
├── human.js          human-behavior primitives (Bézier paths, Fitts timing,
│                     log-normal keystroke cadence, wheel physics)
└── human.sanity.js   browser-less sanity tests for the math in human.js
```

The daemon is **single-process, single-context**. Spawn multiple daemons only if you also use distinct `NATIVEWRIGHT_HOME` roots to avoid lockfile collisions.

## Development

```bash
git clone https://github.com/lipski-lite/nativewright.git
cd nativewright
npm install
npx patchright install chromium     # or: install chrome

# Run the integration smoke test
npm test
```

Tests use Node's built-in `node:test` runner (no external framework). CI runs the same test on Windows, macOS, and Ubuntu via GitHub Actions.

## Acknowledgements

- **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)** by Kaliiiiiiiiii-Vinyzu — does the heavy lifting on stealth; NativeWright is just a daemon wrapper around it.
- **[Playwright](https://playwright.dev/)** by Microsoft — Patchright's upstream.

## License

Apache-2.0 © 2026 lipski-lite.  See [LICENSE](LICENSE) for full text.

## Related projects

- [patchright](https://www.npmjs.com/package/patchright) — the stealth library this is built on.
- [playwright](https://www.npmjs.com/package/playwright) — upstream automation framework.
- [puppeteer](https://www.npmjs.com/package/puppeteer) — alternative browser-automation library (no built-in stealth).

---

<div align="center">
Give your AI coding agent a real browser it can keep logged in.
<br>
<sub>Built for Claude Code, Cursor, Codex, Gemini CLI, and anyone else shelling into Node.</sub>
</div>
