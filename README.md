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
- **Low-level input layer** — click, hover and drag by *coordinates* (css or screenshot space, with the DPR trap handled), HTML5 drag-and-drop and pointer drags, held buttons and keys that persist across commands, key presses with hold/auto-repeat, a quantised mouse wheel that acts on the real scroll container (and can be calibrated to your own device), a real clipboard `paste`, native `<select>`, Russian/English keyboard-layout fidelity, file drops, and opt-in gated touch. See [Coordinates, drag and keys](#coordinates-drag-and-keys).
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

Enabled **by default** on every interaction command. Zero extra dependencies — everything runs on Patchright's existing `page.mouse.*` / `page.keyboard.*` primitives and the CDP `Input.*` domain over the session Patchright already holds.

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
| **Real-time scheduling** | Dwells, key gaps, wheel gaps and path frames are dispatched at their instant by a precise scheduler (a timer for the bulk, a cooperative spin for the last tick), not by Node's `setTimeout`, which lands on the OS timer tick — 15.6 ms on Windows: measured, 86% of click dwells sat within ±1 ms of that lattice and a key-up stamped "down + dwell" reached the page up to 16 ms late. Discrete events (click, key, wheel, touch) carry no timestamp of ours — Chrome stamps them when they arrive, like real input; only the coalesced pointer sub-samples are timestamped explicitly, from a monotonic clock pinned to the browser's own at daemon start (a wall-clock stamp would drift from Chrome's once the system clock is slewed or stepped). |
| **Device-pixel grid** | Every pointer coordinate is snapped to the device-pixel grid (`round(v·dpr)/dpr`: integers at dpr 1), as a real mouse reports physical pixels — the burst sub-samples, paths, overshoot, drags, the wheel position, `drop-files` points and the `--raw` coordinate commands. Touch is exempt (sub-pixel digitizer positions). |
| **Keystroke cadence** | Per-character base mean (letters fast, digits/punctuation slower, uppercase slower due to Shift hold), log-normal jitter, burstiness, post-space and post-punctuation extra pauses, occasional 200-2200 ms mid-sentence pauses. |
| **Per-key dwell** | Individual key down-up hold times sampled independently; keys don't fire in uniform 50 ms pulses. |
| **Typo simulation** | ~0.8% per char chance of pressing the wrong QWERTY neighbour, noticing, pressing Backspace, correcting. **Auto-disabled** for password / OTP / CVV / secret / token fields (detected by `type=password`, name/id/autocomplete attrs). |
| **Scroll physics** | A quantised mouse wheel: whole notches (`deltaY` in multiples of 100, `deltaMode` 0), mostly one per event with the occasional 2–3 in a fast flick, 15–40 ms inside a flick, log-normal "reading" pauses between flicks — or *your* wheel's own statistics after `calibrate-wheel`. **Edge-detection** tracks the scroll offset of the real scroll container under the pointer (an SPA's inner panel, a horizontal scroller, or the document), not `window.scrollY`. |
| **Scroll-to-element** | Wheels naturally toward off-screen elements before interacting (not `scrollIntoViewIfNeeded`, which teleports). |
| **Think-time** | Between actions: three-regime log-normal (15% skip, 60% short 80-900 ms, 20% medium 300-1800 ms, 5% long 700-4500 ms). Prevents detectors from fitting a single distribution to action spacing. |
| **Held inputs** | Mouse buttons and keys can be held across commands (`mouse-down`, `key-down`, `--hold`); every pointer sample carries the held `buttons`, `button` and `modifiers` exactly as Playwright's own mouse would. |
| **Keyboard layouts** | Characters are typed on the physical key of the active layout (US or Russian ЙЦУКЕН); a human Alt+Shift layout switch precedes a character from the other layout; typos hit physically adjacent keys; emoji and other scripts are committed like an IME. |
| **Field clearing** | Triple-click + select-all (Ctrl+A, Cmd+A on macOS) + Delete (matches what users actually do), the keys pressed through the same key emitter as `press` (physical key, human dwell) — handles React-controlled inputs and contenteditables that resist programmatic `fill`. |
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

1. **Locate the binary** — call the `nativewright` bin directly if it's on PATH; otherwise `install.json` under the data root (`~/.local/share/nativewright/` on Linux, `~/Library/Application Support/NativeWright/` on macOS, `%LOCALAPPDATA%\NativeWright\` on Windows) has a `scriptPath` that resolves to `browser.js`. That pointer belongs to the *installed* package: a daemon started from an npm install writes or refreshes it, while a start from a git checkout (or `npm link`) never replaces a valid pointer to another path — it only creates one when none exists or the old one points at a script that is gone (the daemon log says when it declined).
2. **Check status** — `nativewright status` → `{running, pid, port, pageCount, pages}`.
3. **Start if needed** — run `nativewright start` in a background-capable shell (`&`, `nohup`, or the agent's `run_in_background` facility), then `wait-ready`.
4. **Claim a page** — `nativewright new --label=<task>` opens a page in its own window and returns a stable id (`p1`, `p2`, …). Remember it.
5. **Drive the page** — each command is a separate shell call carrying `--page=<id>`; the daemon preserves state between them.
6. **Release the page on task completion** — `nativewright close --page=<id>`. Don't `stop` — other agents may be working; the daemon exits gracefully by itself once no pages have been open for the idle period (flushing cookies so the **next** task opens already logged in).

### Multiple agents at once

Any number of agents can share one daemon. There is **no shared "active page"**: every command names its page, and the daemon binds it to that page inside the page's own queue, so concurrent agents can never clobber each other. Page ids are stable and never re-indexed when another page closes; frame scope, dialog policy and console/network buffers are per page; commands on different pages run concurrently. If more than one page is open and you omit `--page`, the daemon **refuses** with a clear error rather than guessing. Each page lives in its own window, so it stays a foreground, `visibilityState: 'visible'` page even when other windows overlap it (background *tabs* would be hidden and throttled). Artifacts are written under the **caller's** working directory, so agents in different projects don't mix files. In a persistent shell you can pin your page once with `NATIVEWRIGHT_PAGE=p3` instead of repeating the flag.

One daemon serves one profile (identity).

### Named profiles

A separate browser identity is one flag away: put `--profile=<name>` on every command and it runs as its **own daemon** with its own Chrome profile, cookies, extensions and lockfile under `<data root>/profiles/<name>/`. The default profile is untouched. Typical use: a `vpn` profile with a browser VPN extension installed, so work that needs a different IP never changes the IP of the default profile's logged-in sessions — and never affects other agents' pages there.

```bash
nativewright start --profile=vpn &
nativewright wait-ready --profile=vpn
nativewright new --profile=vpn --label=job          # → p1 (in the vpn profile)
nativewright goto https://example.org --profile=vpn --page=p1
nativewright status --profile=vpn                   # → "profile": "vpn"
```

`NATIVEWRIGHT_PROFILE=<name>` does the same for a whole shell. A named profile always owns its own Chrome profile directory — `NATIVEWRIGHT_USER_DATA_DIR` applies to the default profile only. The bundled `nativewright-vpn` Claude Code skill documents the full "blocked by IP → switch to the vpn profile" workflow.

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
|  | `press <key>` | key | `Enter`, `a`, `Control+A`, `Control+Shift+ArrowLeft`; human CDP key emitter; `--hold=<ms>` (auto-repeat), `--repeat=<n>` |
|  | `hover <selector>` | selector | human mouse path to element; `--at=x,y` |
|  | `click-at <x> <y>` | x, y | click a viewport point; `--space`, `--button`, `--clickCount`, `--hold=<ms>`, `--modifiers=`, `--exact` |
|  | `hover-at <x> <y>` | x, y | move the pointer to a viewport point |
|  | `element-at <x> <y>` | x, y | read-only hit test (tag, id, text, box, cursor, draggable, editable, selectorHint, iframe chain) |
|  | `drag <from> <to>` | from, to | element to element; `--from-at`, `--to-at`, `--button`, `--modifiers`; HTML5 vs pointer routed automatically |
|  | `drag-at <x1> <y1> <x2> <y2>` | 4 numbers | viewport point to viewport point |
|  | `mouse-down` / `mouse-up` | — | press / release at the pointer (`--button`); the hold persists across commands |
|  | `key-down <key>` / `key-up <key>` | key | hold / release a key; persists across commands |
|  | `release` | — | release every button and key the page holds (reverse order) |
|  | `type-focused <text>` | text | human typing into the focused element (no click); `--typos=on\|off\|auto` |
|  | `paste <selector> <text>` | selector, text | REAL clipboard paste (human Ctrl+V), `--from-file=<path>`; OS clipboard restored |
|  | `paste-focused <text>` | text | the same, into the focused element |
|  | `drop-files <selector> <path>…` | selector, paths | drop OS files onto an element; `--at=x,y` |
|  | `tap <selector>` / `tap-at <x> <y>` | — | touch tap (refused unless `NATIVEWRIGHT_TOUCH=1`; on that touch-only profile every mouse command is refused instead, see [Touch](#touch-opt-in-gated)) |
|  | `swipe <x1> <y1> <x2> <y2>` / `pinch <x> <y> --scale=<f>` | — | touch gestures (same gate) |
|  | `calibrate-wheel` | — | record the human's own wheel (`--seconds=10`) on a blank or local page (`new` starts on `about:blank`); only a human calibration is adopted |
|  | `select <selector> <value>` | selector, value | native `<select>`: real click, arrow keys, Enter (multiple: click / Ctrl-click); matches value or label; `--raw` = `selectOption` |
|  | `scroll <up\|down\|left\|right\|top\|bottom\|<px>>` | direction | quantised wheel on the scroll container under the pointer; `--dx=<px>`, `--target=<selector>`, `--x=<n> --y=<n>` |
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
| Artifacts | `shot [name]` | name? | PNG under the caller's `./artifacts/`; `--scale=device\|css`, `--selector=<sel>`, `--fullPage`; returns `dpr`, `viewport`, `scroll`, `imageSize`, `clip` |
|  | `save-artifact [name]` | name? | PNG + HTML + metadata JSON bundle |
|  | `downloads [--n=N]` | — | this page's captured downloads with auto-saved paths |
| Diagnostics | `console [--n=N]` | — | this page's recent `console.*` messages (re-injected hook) |
|  | `network-log [--n=N]` | — | this page's recent requests/responses |
|  | `state` | — | pages, idle timer, command ring buffer (pageless) |
| Viewport | `viewport <w> <h> --force` | w, h | overrides the real window geometry; requires `--force` |

## Coordinates, drag and keys

The selector commands (`click`, `fill`, `hover`, …) are the default: a selector survives layout changes and the command scrolls the element into view for you. Reach for **coordinates** when there is no usable selector — a `<canvas>`, a game, a map, a drawing surface, a widget in a cross-origin iframe, something you only know from a screenshot.

| You have… | Use |
|---|---|
| a stable selector | `click`, `drag`, `hover`, … (add `--at=x,y` to aim *inside* the element) |
| a point on the screen | `click-at`, `hover-at`, `drag-at`; `element-at` first if you want to know what is there |
| only a screenshot | `shot`, read the point off the image, then `click-at … --space=screenshot` |

All coordinate commands work at **page level** (they ignore the `frame` scope): raw input at page coordinates is routed by Chrome into iframes, cross-origin ones included.

### Coordinate spaces and the DPR trap

`--space=css` (default) is CSS pixels relative to the viewport — the numbers `clientX`/`clientY` report. `--space=screenshot` is device pixels measured on a `shot` image taken with the default `--scale=device`; the daemon converts with `css = px / devicePixelRatio`. For offsets inside an element (`--at`), measure on an element screenshot (`shot --selector=…`).

On a display scaled to 150% `devicePixelRatio` is 1.5 and the screenshot is 1.5× larger than the page is in CSS pixels. Worked example, from this repo's own test machine (viewport 1166×726 CSS px, dpr 1.5):

```bash
nativewright shot home --page=p1
# → { "dpr": 1.5, "viewport": { "width": 1166, "height": 726 }, "imageSize": { "width": 1749, "height": 1089 }, … }
# you read the Button's centre off the image: (1177.5, 243) device pixels
nativewright click-at 1177.5 243 --page=p1
# → ok:false  point (x=1177.5, y=243) [space=css] is outside the viewport: viewport 1166x726 CSS px, dpr 1.5;
#             converted to css (1177.5, 243); … (hint: did you mean --space=screenshot?)
nativewright click-at 1177.5 243 --space=screenshot --page=p1
# → css (785, 162): the Button
```

A point that happens to fit inside the viewport is *not* rejected — it just lands 50% too far right/down — so always say which space you measured in. `shot` returns everything needed to convert: `dpr`, `viewport`, `scroll`, `scale`, `imageSize` (read from the PNG header) and `clip` (the CSS rectangle the image covers; the element's box with `--selector`). `--scale=css` gives one image pixel per CSS pixel and makes the two spaces equal. Every validation error states the viewport size, the dpr and the converted css values.

### What is there? `element-at`

```bash
nativewright element-at 520 160 --page=p1
# → { css, dpr, viewport, hit: { tag, id, classes, role, name, text, href, box, cursor, draggable, editable, selectorHint }, frames: [ { url, box } ] }
```

Read-only (no input is dispatched). `draggable` is *effective* (an ancestor's, `img` and `a[href]` are draggable by default); `selectorHint` is a short selector that matches exactly that element; when the point is inside an iframe — same- or cross-origin — `hit` is the innermost element (its `box` in page viewport px) and `frames` is the chain that was drilled through. `click-at`/`hover-at` run the same hit test first (the Fitts target width comes from the element found) and return it as `hit`. `click-at` lands on your point plus a hand's tiny jitter (σ≈0.6 px, ≤ 2 px); `--exact=true` skips only that jitter. The landing point is snapped to the **device-pixel grid** — integers at `devicePixelRatio` 1, multiples of 1/dpr otherwise, which is what a real mouse reports (it reports physical pixels) — and that snapped point is what `landedAt` reports and what the page sees in `PointerEvent.clientX/Y`, in every coalesced sub-sample as well. (Measured before: Playwright passes a float straight through — a mouse press at (120.43, 60.29) arrived as `clientX` 120.43000030517578, and 16 of 569 pointer coordinates of a click grid were fractional.) The same grid applies to every pointer coordinate the daemon dispatches — paths, overshoot, drags, the wheel's position, `drop-files` points and the `--raw` coordinate commands; touch coordinates are not snapped (a digitizer reports sub-pixel positions), and the selector commands that Playwright positions itself under `--raw` (`click <selector> --raw` and friends) stay robotic.

### Drag: two different mechanisms

`drag <from> <to>` and `drag-at <x1> <y1> <x2> <y2>` look at the start point and choose:

| Start point | `mode` | How the moves are sent |
|---|---|---|
| an HTML5-draggable element (effective `draggable`) | `html5` | through Playwright's mouse, one awaited move per path point — patchright's drag manager only intercepts drags that *its* mouse causes; you get real `dragstart`/`dragenter`/`dragover`/`drop`/`dragend` with the `dataTransfer` payload |
| anything else: sliders, canvases, resize handles, custom pointer-event drags | `pointer` | the usual coalesced raw-CDP pointer bursts with the button held (`buttons: 1`, `pressure: 0.5`, `getCoalescedEvents().length > 1`) |

This is required, not cosmetic: on Chrome 149 raw CDP moves over a draggable start a native drag (`dragstart` fires) but never deliver `dragenter`, `dragover`, `drop` or `dragend`. The human drag is: move to the start → settle → modifiers down → press → ~150 ms pre-drag hold → move to the end *with the button held* (Fitts × 1.4, a little wobble, never an overshoot) → 80–200 ms settle → release → modifiers up. Options: `--from-at`/`--to-at` (offsets inside the elements), `--button`, `--modifiers`, `--raw` (Playwright `dragTo` / stepped moves). A source and target that are not both visible are an error rather than a guess.

### Holds and `release`

```bash
nativewright key-down Shift --page=p1          # stays down across commands
nativewright click-at 300 200 --page=p1        # → mousedown.shiftKey === true
nativewright mouse-down --page=p1              # a button, at the current pointer
nativewright hover-at 500 200 --page=p1        # drag by hand: the moves carry buttons=1
nativewright mouse-up --page=p1
nativewright pages                              # input: { pointer: {x,y}, held: { buttons: [...], keys: [...] }, layout }
nativewright release --page=p1                 # lets go of everything, in reverse order of pressing
```

State is per page and visible in `pages`/`state`, so a forgotten hold is easy to spot. Commands that press something themselves (`click-at --modifiers`, `drag`, `press`) release exactly what *they* pressed, even on error or timeout; explicit `key-down`/`mouse-down` holds persist by design. A button that is already held cannot be pressed again. Closing a page releases what it still holds. `--modifiers` takes `Control,Shift,Alt,Meta` (case-insensitive; `Ctrl`, `Cmd`, `Win`, `Option` aliases). Modifier keys go through Playwright's keyboard so they are stamped onto its mouse events too.

### Keys

`press` is human by default: `press Control+Shift+ArrowLeft` presses the modifiers first (a 40–120 ms lead each), the main key with a human dwell, and releases in reverse with lag; the page sees `ControlLeft↓ ShiftLeft↓ ArrowLeft↓ ArrowLeft↑ ShiftLeft↑ ControlLeft↑`. Dwells and gaps are dispatched in real time by a precise scheduler (no 15.6 ms timer tick), and these discrete events carry no timestamp of ours: Chrome stamps them when they arrive, like real input. `--hold=<ms>` keeps the main key down — past ~500 ms (±60, sampled per press) it **auto-repeats** with `autoRepeat: true` keydowns every ~33 ms (OS auto-repeat is timer-regular), and a held *printable* key keeps typing, exactly like hardware: `press a --hold=1200` in an input types `aaaaaaaaaaaaaaaaaaaaaa`. `--repeat=<n>` presses n times with human gaps. `key-down`/`key-up` accept the named keys (Shift, Control, Alt, Meta, Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, Space, F1–F12), single printable characters and physical codes such as `KeyA`; anything else is an error. `type-focused <text>` types into whatever has focus (no click) — if nothing editable is focused the key events still go out, which is what a canvas game listening on `window` needs. `type`, `fill`, `type-focused` and the paste fallback all honour `--typos=on|off|auto`.

### Scrolling

```bash
nativewright scroll down --target=".chat-panel" --page=p1   # move the pointer into the panel, then wheel
nativewright scroll right --target="#timeline"              # horizontal scrollers
nativewright scroll 3000 --x=600 --y=400                    # wheel at a viewport point
nativewright scroll --dx=400                                # an explicit horizontal amount
nativewright scroll bottom                                  # to the container's edge
```

The wheel acts on the **scroll container under the pointer** — the nearest ancestor that scrolls on that axis (a single-page app's inner panel, a horizontal scroller), else the document — and edge detection tracks *that* container's scroll offset. (The old code watched `window.scrollY`, which never moves when an inner panel scrolls: asked for 3000 px it scrolled 452 px and stopped.) The response reports the container and what really happened: `{ scrolledBy, axis, container: { tag, id, isDocument }, before: {x,y}, after: {x,y}, events, … }`.

A physical wheel is quantised: the default model sends whole notches (`deltaY`/`deltaX` in multiples of 100, `deltaMode` 0 — mostly one notch per event, occasionally 2–3 in a fast flick, 15–40 ms apart, with reading pauses between flicks), so a request is approximate (`scroll 30` is one notch = 100 px) and `scrolledBy` is the distance actually moved. A box that only has a wheel handler (nothing natively scrollable, e.g. a custom virtual list) still receives the events and is reported `scrollable: false`. **`calibrate-wheel`** replaces the default with *your* device: open a blank page (`nativewright new --label=calibrate` starts on `about:blank`) and run `nativewright calibrate-wheel --seconds=10 --page=<id>` there, scroll with your own mouse wheel behind the on-page overlay, and the delta quantum, flick lengths and gap statistics are stored machine-wide in `<data root>/wheel-calibration.json` (fewer than 20 events is rejected); the scroll engine then samples from your profile. The overlay is a DOM element and the recorder a page listener, both visible to a site's own scripts, so **calibrate-wheel refuses any page that is not `about:blank`, a `data:` or `file:` URL, or `http(s)` on `localhost` / `127.0.0.1` / `[::1]`** — the error says so and names the blank-page way out. **Only a human calibration is adopted**: `--simulate=true` (a self-test that feeds the recorder through CDP) writes a profile marked `source: simulated`, which is saved but never used for scrolling — learning from our own synthetic events would be circular. `calibrate-wheel`, `scroll`, `state` and `status` report the model in force (`wheelModel: 'default' | 'human'`; `state` also shows `wheelCalibration` with `adopted`).

### Clipboard paste

`paste <selector> <text>` (click/focus the field like a person, then paste) and `paste-focused <text>` perform a **real paste**: the text is placed on the OS clipboard, a human Ctrl+V follows (Control through Playwright's keyboard, `V` through the CDP key emitter; Cmd on macOS), and the page receives a trusted `paste` event with `clipboardData` and a `beforeinput` of `inputType: 'insertFromPaste'` — what sites that special-case pasted text expect. `--from-file=<path>` (relative to your cwd) pastes a long file.

The clipboard belongs to the human user and is shared by every daemon, so: a **machine-wide, per-OS-user lock** (`<os.tmpdir()>/nativewright-clipboard.lock` — `nativewright-clipboard-<uid>.lock` on Linux/BSD, where `/tmp` is shared; created exclusively, holding `{pid, page, id, at, hb}`; the holder refreshes `hb` every second, so the lock is kept for as long as its holder is alive and is reaped when its pid is dead or there has been no heartbeat for 15 s; waits up to 10 s) serialises pastes across **every** daemon — it is deliberately *not* under `NATIVEWRIGHT_HOME`, because the clipboard belongs to the OS session, not to a data root, so daemons with different roots (named profiles under another root, test daemons) still queue instead of overwriting each other's payload; **only an empty or plain-text-only clipboard is ever touched** — an image, a file list, HTML/RTF or any other format is left exactly as it is and the text is typed instead; the previous text is restored afterwards, and only while the clipboard still holds our payload (if you copied something else meanwhile, yours stays). Clipboard contents are never logged or returned. Windows uses a long-lived `powershell -STA` helper (started before the lock is taken; it keeps dispatching window messages while idle, because an owner that does not makes other applications' clipboard writes wait about 5 s; every call inside the lock times out after 10 s, and a helper that still owes an answer is killed before the lock is released), macOS `pbpaste`/`pbcopy`, Linux `wl-clipboard` or `xclip` (`xsel` as a last resort).

The response is `{ method, chars, verified, clipboardRestored, clipboardTouched, lockWaitMs, reason?, detail? }`. `method: 'typed'` with a `reason` code (`headless`, `no-clipboard-tool`, `non-text clipboard`, `clipboard-busy`, `clipboard-unreadable`, `clipboard-unwritable`, `paste-no-effect`; `detail` has the specifics, e.g. the format names found) means the safe fallback was used: headless Chrome (its clipboard lives inside the browser process, not the OS), no clipboard tool, a non-text clipboard, a lock that stayed busy for 10 s, a clipboard that could not be read or a helper that could not be started (`clipboard-unreadable`), a clipboard another application holds open (clipboard managers do), or a Ctrl+V that changed nothing. If the clipboard is stuck mid-paste the helper is stopped and the restore is tried once through a fresh one; unless the original is confirmed back, `clipboardRestored` is `false` with a `restoreNote`. The typed fallback is for short texts: it types at a human's pace (~190 ms a character) while the page's command queue is blocked, so a text longer than **2000 characters** (headless, or a busy clipboard, with `--from-file` up to 5 MB) is refused instead of typed for hours — the error names the fallback reason, says how many minutes typing it would take, and suggests a headed daemon with an empty or plain-text clipboard (a real paste), or `fill --raw=true` for bulk text.

Two caveats. On Windows the payload is flagged so that clipboard history (Win+V), cloud clipboard sync and clipboard monitors that honour the Windows exclusion formats skip it (your own text is restored as plain text, without the flags), but any application can read the clipboard while the payload is on it and a tool that ignores the flags may record it — **never use `paste` for a secret**; `fill`/`type` never touch the clipboard. And the first paste in a daemon pays the clipboard helper's start-up (1–10 s for PowerShell on a slow machine; `paste <selector>` hides most of it behind the human click).

### Keyboard layouts

Typing is done on physical keys, so a layout is a map from characters to `{code, keyCode, shift}`. Latin text uses the US layout; Cyrillic uses Russian ЙЦУКЕН (`й` is `KeyQ`/81, `ф` is `KeyA`/65, `ж` is `Semicolon`/186, … — `key` is the character, `code` and `keyCode` those of the key position; capitals are Shift + the same key). The active layout is tracked per page (`pages` → `input.layout`, starting at `en`). When the next character is only typable on the other layout the engine first performs what a person does: a layout-switch chord (Alt down, Shift down, Shift up, Alt up — the page sees those modifier events exactly as on hardware; `NATIVEWRIGHT_LAYOUT_SWITCH=ctrl+shift` changes it), then continues. A character typable on both (`.` is Period on EN and Slash on RU) uses the active layout's key and needs no switch. Characters on neither layout — emoji, CJK, other scripts — are committed with `Input.insertText` (what an IME or emoji picker does): never a keydown with an empty `code`/`keyCode 0`. Typo simulation picks a physically adjacent key, so a Russian typo is the Russian letter beside the intended one. Shortcuts such as `Control+A` are pressed by key position and never switch layouts. Note the OS layout itself is not changed; only the events differ. On macOS a shortcut chord (Control/Cmd + key) goes through Playwright's keyboard (the CDP emitter does not trigger macOS editing commands), which names the key by its US-layout character: with the Russian layout active the page sees `code: "KeyA"` but `key: "a"`, not `"ф"` (measured in CI).

### Native `<select>`

`select <selector> <value>` opens the list with a real click, walks to the option with ArrowDown/ArrowUp at human cadence (disabled options are skipped when counting), presses Enter, and verifies the value (`method: 'keyboard'`); if verification fails it falls back to `selectOption` (`method: 'fallback'`). `<select multiple>`: a plain click on the first option, Ctrl-click (Cmd on macOS) on each further one. `<value>` matches an option's value or label; for `multiple` pass a JSON array (`'["2","4"]'`). `--raw=true` is plain `selectOption`. Measured on macOS (CI, headless Chromium): the key walk does not take effect there (probably because macOS lists a select as a native menu and an arrow key on a closed select opens it: a guess, not verified), so the command falls back to `selectOption` and says so (`method: "fallback"`, with the `reason`); the final value is right either way. The key walk is verified on Windows and Linux; headed macOS is not verified.

### Touch (opt-in, gated)

`tap <selector>`, `tap-at <x> <y>`, `swipe <x1> <y1> <x2> <y2>` and `pinch <x> <y> --scale=<factor>` dispatch real touch events with human finger paths (touchStart → frame-paced touchMove → touchEnd; varying contact radius and pressure; a pinch is two staggered contacts). They are **refused** unless the page reports touch capability, because a "desktop" that reports `navigator.maxTouchPoints === 0` yet delivers `touchstart` is a physically impossible, detectable contradiction — and Chrome *does* deliver touch events dispatched over CDP in that state (verified). To use them start a separate touch-capable daemon: `NATIVEWRIGHT_TOUCH=1 nativewright start --profile=touch`.

**The mirror image: a touch daemon refuses the mouse.** Touch support also turns the page into a touch-*only*, tablet-class device (table below), and such a device cannot produce `pointerType: 'mouse'` events or a wheel. So on a page that reports `(any-pointer: fine)` false, every mouse-dispatching command is **refused** with an error that names the alternatives — `click`, `dblclick`, `rightclick`, `hover`, `click-at`, `hover-at`, `drag`, `drag-at`, `mouse-down`, `mouse-up`, `scroll` (wheel), `calibrate-wheel --simulate`, and the selector text commands that focus their field with a click (`fill`, `type`, `select`, `paste <selector>`) — and **`--raw` does not lift it**. The workflow on this profile: `tap` the field, then `type-focused` / `paste-focused` / `press` / `key-down` / `key-up` / `release`; `swipe` to scroll, `pinch` to zoom; `drop-files`, `element-at` and `shot` work as usual (an off-screen `tap` or `drop-files` target is scrolled into view with finger drags, never a wheel; `drop-files`, an OS file drag, does not move a mouse pointer that does not exist). Hover-only UI is out of reach there by design. A normal daemon is the other half of the same rule: it refuses touch.

What `NATIVEWRIGHT_TOUCH=1` does to the fingerprint (measured on Chrome 149, headed and headless alike): `hasTouch` makes `navigator.maxTouchPoints` 1 (the daemon raises it to 10 on every page, consistently inside cross-origin iframes), `'ontouchstart' in window` true — and also flips the media profile to a *touch-only* device: `(pointer: coarse)` and `(any-pointer: coarse)` match, `(any-pointer: fine)`, `(pointer: fine)` and `(any-hover: hover)` do **not**, `(hover: none)` matches. That is the profile of a tablet with no mouse, not of a touchscreen laptop (which would also match `any-pointer: fine` and `any-hover: hover`), and Chrome offers no flag or CDP override for those media features (`Emulation.setEmulatedMedia` ignores them; `--touch-events=enabled` alone gives `ontouchstart` with `maxTouchPoints: 0`, worse). The measured profile, which the mouse refusal is keyed on (`matchMedia` values, identical headed at dpr 1.5 and headless):

| page profile | `maxTouchPoints` | `ontouchstart` | `pointer` fine / coarse | `any-pointer` fine / coarse | `hover` hover / none | `any-hover` hover / none |
|---|---|---|---|---|---|---|
| default daemon | 0 | false | **true** / false | **true** / false | true / false | true / false |
| `NATIVEWRIGHT_TOUCH=1` | 10 | true | false / **true** | **false** / true | false / true | false / true |

Use the touch daemon only for sites that need touch input, never for the logged-in default profile. A pinch's `--scale` is the ratio of the two finger distances; Chrome amplifies it (a 2× ratio zoomed the visual viewport to 4×).

### File drops

`drop-files <selector> <path> [<path>…]` drops files from disk onto a drop zone the way a person drags them from the file manager: the drag **enters from the window edge nearest the target**, `dragover` events follow a human path to a point inside the element (or `--at=x,y`), it settles briefly, and drops. Implemented with `Input.dispatchDragEvent` carrying the real paths, so the page gets trusted `dragenter`/`dragover`/`drop` events whose `DataTransfer.files` hold real `File` objects (name, size, type, content). The drag offers what a file manager's does — copy, link and move (`dataTransfer.effectAllowed` is `'all'`) — so a page that answers with `dropEffect = 'move'` still gets its drop (measured: offering `copy` only gave `effectAllowed` `'copy'`, and then such a page got no drop at all). Dropping on an `<input type=file>` fills it and fires `change`. Paths resolve against your working directory and must exist and be files. The page receives the file contents, so drop files only onto sites you trust.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `NATIVEWRIGHT_HOME` | per-user data root | platform default (see below) |
| `NATIVEWRIGHT_USER_DATA_DIR` | persistent browser profile path | `<HOME>/profile/default` |
| `NATIVEWRIGHT_ARTIFACTS_DIR` | force one screenshot & bundle output directory | the **caller's** `./artifacts` |
| `NATIVEWRIGHT_PAGE` | default `--page` for a shell (explicit flag wins) | unset |
| `NATIVEWRIGHT_PROFILE` | named profile for a shell (same as `--profile=<name>`) | default profile |
| `NATIVEWRIGHT_IDLE_EXIT_MS` | graceful exit after the last page has been closed this long; `0` = never | `600000` (10 min) |
| `NATIVEWRIGHT_CHROME_PATH` | explicit browser binary path | auto-detected |
| `NATIVEWRIGHT_CHANNEL` | Patchright channel | `chrome` |
| `NATIVEWRIGHT_HEADLESS` | headless mode (**CI only — breaks stealth**) | `false` |
| `NATIVEWRIGHT_NO_EXEC_PATH` | skip local Chrome probe (let Patchright resolve) | `false` |
| `NATIVEWRIGHT_TOUCH` | launch a touch-capable browser (enables `tap` / `swipe` / `pinch`; the profile becomes touch-only, so mouse commands are refused; see [Touch](#touch-opt-in-gated)) | `false` |
| `NATIVEWRIGHT_LAYOUT_SWITCH` | shortcut used for the EN↔RU layout switch: `alt+shift` or `ctrl+shift` | `alt+shift` |
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
├── human.js          human-behavior primitives (Bézier paths, Fitts timing, per-page input state,
│                     key emitter, layout-aware typing, container-aware wheel scrolling)
├── timing.js         precise sleep (a timer + a cooperative spin: off the OS timer tick) and the monotonic event clock pinned to Chrome's
├── keys.js           named keys, modifier names/aliases, combo parsing
├── layouts.js        US + Russian layouts keyed on physical codes, typo neighbours
├── wheel.js          quantised wheel model + calibration profile (machine-wide)
├── coords.js         coordinate spaces (css / screenshot) and validation
├── inspect.js        hit testing, iframe/shadow drill-in, scroll-container discovery
├── clipboard.js      OS clipboard backends + the machine-wide (per OS user, os.tmpdir()) clipboard lock
├── paste.js          the real-paste flow (start helper → lock → snapshot → Ctrl+V → verify → restore → unlock)
├── touch.js          gated touch gestures (+ finger-drag scrolling for touch-only pages)
├── modality.js       input modality must match the fingerprint: mouse commands refused on touch-only pages
├── filedrop.js       OS file drag-and-drop
└── human.sanity.js   browser-less sanity tests for the maths and the typing engine
```

The daemon is **single-process, single-context**. Spawn multiple daemons only if you also use distinct `NATIVEWRIGHT_HOME` roots to avoid lockfile collisions.

## Development

```bash
git clone https://github.com/lipski-lite/nativewright.git
cd nativewright
npm install
npx patchright install chromium     # or: install chrome

# Integration tests: the smoke test + the input-layer suite (real daemon, real Chrome)
npm test                                  # headed
NATIVEWRIGHT_HEADLESS=1 npm test          # headless (CI)
npm run test:sanity                       # browser-less maths / typing-engine checks
```

Tests use Node's built-in `node:test` runner (no external framework). CI runs the same test on Windows, macOS, and Ubuntu via GitHub Actions. The input-layer suite (`test/input.test.js`) starts its own daemons with fresh temporary `NATIVEWRIGHT_HOME` / `NATIVEWRIGHT_USER_DATA_DIR` / `NATIVEWRIGHT_ARTIFACTS_DIR` (it never touches a real profile or a running daemon) and takes several minutes; run it headed once in a while and leave the mouse alone while it does, because a physical mouse move competes with the injected one. One test is headed-only (two daemons with different `NATIVEWRIGHT_HOME` pasting at once through the one OS clipboard), and the paste tests adapt to the clipboard they find: they never touch one that holds anything but plain text or nothing.

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
