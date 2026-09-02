# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-09-02

Multi-agent release. Any number of clients can now share one daemon safely,
each with its own page in its own window. This changes the command contract
(see **Removed** / **Changed**) — hence the major bump.

### Added
- **Stable page ids.** `new` returns `p1`, `p2`, … — an id that never changes for the page's lifetime and is never reused, even when other pages close. `new` accepts `--label=<name>` (shown by `pages` so a person can tell whose window is whose) and `--window=false` to open a tab instead of a window.
- **Explicit, atomic page targeting.** Every page command takes `--page=<id>`; the daemon binds the command to that page inside the page's own serialized queue. Commands on different pages run concurrently. Responses echo the targeted page: `{ok, page, result}`.
- **Ambiguity refusal.** With more than one page open and no `--page`, the daemon refuses with a clear error instead of guessing. A lone page needs no flag. `NATIVEWRIGHT_PAGE=<id>` pins a default page for a shell; the REPL pins the page it creates (`use <id>` / `use` to change or clear).
- **A window per page.** `new` opens each page in its own browser window (`Target.createTarget newWindow`). A page in its own window stays a foreground page — `visibilityState: 'visible'`, timers and rAF running — even when other windows overlap it. Windows are cascaded so a person sees them apart. Falls back to a tab if the browser-level CDP session is unavailable.
- **Per-page state.** Frame scope (`frame`), dialog policy (`dialog`), and console / network / download buffers are now per page instead of daemon-global.
- **Artifacts next to the caller.** `shot`, `save-artifact`, and captured downloads are written under the requesting client's working directory (`./artifacts/`), so agents in different projects don't mix output. `upload` and `eval-file` paths resolve relative to the caller too. `NATIVEWRIGHT_ARTIFACTS_DIR` still forces one location.
- **Lease-based lifecycle.** Clients `close --page=<id>` when done. When no pages have been open for `NATIVEWRIGHT_IDLE_EXIT_MS` (default 10 min; `0` = never) the daemon exits gracefully, flushing the profile. `stop` refuses while pages are open; `stop --force` shuts down regardless. A minimized internal keeper window keeps Chromium alive between leases.
- `status` now reports `pageCount` and the open pages (id, label, url); `--verbose` adds the idle-timer state. Log lines are tagged with the page they acted on (`[p3] fill ok 6272ms`).
- Env vars are accepted under both `NATIVEWRIGHT_` and the legacy `PATCHRIGHT_` prefix, so neither spelling is silently ignored.

### Changed — human-behavior layer
- **Pointer coalescing.** Mouse motion is dispatched as per-frame bursts of sub-samples via CDP with explicit monotonically increasing timestamps, so `PointerEvent.getCoalescedEvents()` returns several distinct, correctly ordered samples per `pointermove` (scaling with motion speed) instead of always exactly one. Falls back to the classic per-point path if a CDP session can't be created.
- **Keyboard.** Keystrokes are emitted via CDP keyed on the physical `code`, with explicit `ShiftLeft` keydown/keyup around capitals and shifted symbols (Shift is held across consecutive shifted characters, as a typist does). The typo path uses the same emitter. Per-key dwell is encoded in the keyUp timestamp, so observed dwell is a continuous value rather than one snapped to the OS timer tick. Unmapped characters (emoji, accented letters, CJK) fall back to the previous press path.
- **Field clearing.** The select-all gesture before typing varies per call (triple/double/single/no click, then `Ctrl+A`, then `Delete` or `Backspace`) instead of one fixed sequence.
- **Think-time.** The 15% "fast hand-off" branch now returns a brief non-zero pause instead of exactly 0 ms.

### Removed
- `switch <index>` — there is no shared active page anymore. Calling it returns an error explaining `--page=<id>`.
- Numeric page indices. `pages` reports ids.
- `close-page` is kept as an alias of `close` but is deprecated.

### Migration
1. After `start` / `wait-ready`, call `nativewright new --label=<task>` and keep the returned `page` id.
2. Add `--page=<id>` to every page command (or export `NATIVEWRIGHT_PAGE=<id>` in a persistent shell).
3. Replace `switch N` + command with the command itself carrying `--page=<id>`.
4. Replace the end-of-task `stop` with `close --page=<id>`. Use `stop` only as an administrative shutdown (`--force` if pages are open).

## [1.0.0] — 2026-04-22

Initial public release.

### Added — human-behavior layer (the differentiator vs. raw Patchright)
- `src/human.js` — primitives for realistic input synthesis. Zero new deps; runs on Patchright's existing `page.mouse.*` and `page.keyboard.*` only.
- Cubic Bézier mouse trajectories with perpendicular control-point offsets + per-sample Gaussian jitter. Three easing curves picked per move.
- Fitts-law movement durations (log-normal around `80 + 90·log2(d/w + 1)` ms).
- Overshoot-and-correct (~20% of long moves), mid-path hesitation (~12%), aspect-aware landing distribution inside the target's bbox.
- Keystroke cadence: per-character base mean, log-normal inter-key gaps, burstiness, post-space / post-punctuation pauses, occasional long mid-sentence pauses.
- Per-key `keydown`→`keyup` dwell times sampled independently.
- Typo simulation using a QWERTY-neighbour map; auto-disabled for password/OTP/CVV/PIN/secret/token fields.
- Real `page.mouse.wheel` scroll with variable tick magnitude, log-normal inter-tick gaps, "reading" pauses, and edge-detection via `window.scrollY` stall.
- Natural wheel-scroll-to-element before interacting with off-screen targets.
- Three-regime log-normal think-time between actions.
- Triple-click + Ctrl+A + Delete field-clearing (handles React-controlled inputs and contenteditables).
- Seeded mulberry32 PRNG via `--seed=<int>` for reproducible runs.
- `--raw=true` opt-out on every interaction command for cases where robotic precision is required.
- New commands: `dblclick`, `rightclick`.
- `src/human.sanity.js` — browser-less unit tests for the math (`npm run test:sanity`).

### Added — core daemon
- HTTP-RPC daemon that owns a single Patchright `BrowserContext`.
- **Strip `--no-sandbox` from Chrome args by default** on Windows / macOS / non-root Linux. Keeps it on root Linux (CI / Docker) where it's genuinely needed. Overridable via `NATIVEWRIGHT_ALLOW_NO_SANDBOX=1`. Motivation: Patchright's defaults include `--no-sandbox`, which (a) triggers Chrome's yellow warning bar, (b) is a bot-telltale for anti-bot systems, (c) disables renderer sandbox isolation.
- One-shot CLI client + interactive readline REPL, sharing the same entry point.
- Persistent profile under a platform-native data root (Windows `%LOCALAPPDATA%`, macOS `~/Library/Application Support`, Linux `~/.local/share` / XDG).
- Cross-platform Chrome / Chromium binary discovery with an `NATIVEWRIGHT_CHROME_PATH` override.
- `NATIVEWRIGHT_CHANNEL` env override (`chrome`, `chromium`, `msedge`, `chrome-beta`).
- `NATIVEWRIGHT_HEADLESS` env flag for CI smoke tests (breaks stealth — CI only).
- Lockfile at `$NATIVEWRIGHT_HOME/daemon.json` with PID + ephemeral port + recorded `scriptPath`.
- Stale-lockfile reaper on `start` (verifies PID aliveness + HTTP ping).
- Structured daemon log at `$NATIVEWRIGHT_HOME/logs/daemon.log` with per-command timing.
- In-page console hook that survives Patchright's `Runtime.enable` suppression; re-injected after every navigation.
- Auto-saved downloads via `page.on('download')` → `artifactsDir`.
- ANSI-stripped error messages for clean JSON output.
- Full command surface: pages, navigation, interaction, waiting, inspection, frames, dialogs, artifacts, diagnostics, viewport.
- Claude Code skills: `nativewright`, `nativewright-login-bootstrap`.
- GitHub Actions CI matrix: Windows, macOS, Ubuntu × Node 20.
- Integration smoke test (`npm test`): launch → goto example.com → text h1 → stop.
- JSDoc type annotations across all `src/*` modules.

[1.0.0]: https://github.com/lipski-lite/nativewright/releases/tag/v1.0.0
