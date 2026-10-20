# NativeWright — Agent Instructions (Codex / any CLI agent)

NativeWright wraps Patchright (a stealth-patched Playwright fork) in a long-lived HTTP daemon, so coding agents can drive ONE real Chrome with a persistent logged-in profile across many one-shot shell calls, with a built-in human-behavior input layer (Bézier mouse paths, keystroke cadence, scroll physics) that defeats anti-bot input fingerprinting.

**Iron rule: route EVERY browser action through this daemon.** Never launch Playwright/Puppeteer/Chrome directly, never spawn a second automation stack — that loses the shared session state and burns the stealth profile.

---

## 1. Resolving the binary

The package is installed globally; `nativewright` is on PATH. Resolution order:

1. `nativewright <cmd>` — preferred (npm global bin).
2. If PATH lookup fails, read the install pointer and call via node:
   - Windows: `%LOCALAPPDATA%\NativeWright\install.json` → `{"scriptPath": "..."}`
   - macOS: `~/Library/Application Support/NativeWright/install.json`
   - Linux: `${XDG_DATA_HOME:-~/.local/share}/nativewright/install.json`
   - Then: `node "<scriptPath>" <cmd> [args...]`
   - The pointer belongs to the INSTALLED package: a daemon started from an npm install writes it, a start from a git checkout (or `npm link`) never replaces a valid pointer to another path (it only creates one when none exists or the old one points at a missing script). So if the pointer names a checkout, that is where someone put it; do not "fix" it by starting a daemon from a clone.
3. If nothing installed: `npm install -g nativewright && npx patchright install chrome`, run `nativewright start` once to self-register, then `stop`.

Never hardcode absolute paths in scripts or code you write — always resolve via PATH or the install pointer.

## 2. Lifecycle (every session)

```
nativewright status                      → {"running": true|false, "pid": ..., "port": ...}
```

**If `running: false` — you are the OWNER:**

Start the daemon DETACHED (it's long-lived; a foreground call would hang your shell):

```powershell
# PowerShell (Windows — this machine):
Start-Process -WindowStyle Hidden nativewright -ArgumentList 'start'
```
```cmd
:: cmd.exe alternative:
start /b nativewright start
```
```bash
# bash/zsh alternative:
nativewright start &>/dev/null &
```

Then block until ready:

```
nativewright wait-ready --timeout=30000
```

As OWNER you MUST call `nativewright stop` when ALL your browser work is done (before your final answer). `stop` flushes cookies/localStorage to disk, releases the profile lock, reaps Chrome. Killing the PID instead risks a logged-out profile and a stale lock.

**If `running: true` — you are a JOINER:**

Another agent or the human owns the daemon. Do NOT call `stop` — ever. Claim your own page and clean only it up at the end (see §3).

## 3. Multi-agent protocol (claim a page, address it by id)

The daemon has **no shared active page**: every page has a stable id (`p1`, `p2`, …) and every page command names it with `--page=<id>`. Concurrent agents can never clobber each other. You usually CANNOT tell whether other agents are around — follow this protocol by default.

```
nativewright new --label=<task>                          → {"page": "p3", ...}   # claim YOUR page, remember the id
nativewright goto "https://example.com" --page=p3
nativewright click "button.submit" --page=p3
```

If exactly one page is open `--page` may be omitted; with more than one the daemon **refuses** to guess. `NATIVEWRIGHT_PAGE=p3` pins a default for a persistent shell.

Commands that DON'T take `--page`: `status`, `wait-ready`, `pages`, `state`, `ping`, `help`, `new`, `stop`, `cookies`.

**End of task:**
- OWNER → `nativewright close --page=p3`, then `nativewright stop`
- JOINER → `nativewright close --page=p3` (removes only your page; never `stop`)

## 4. Output contract

Every one-shot prints JSON. Exit code 0 ⇔ `"ok": true`; exit code 1 ⇔ `"ok": false` with an `error` field. The daemon survives failed commands — on `ok:false`, diagnose immediately (`console`, `network-log`, `state`), don't restart.

Response shapes you'll see:
- `status` → `{"running": true, "pid": 1234, "port": 9377}`
- `goto` → `{"ok": true, "result": {"url": "...", "status": 200, ...}}`
- `html` → `{"ok": true, "result": {"html": "..."}}`
- `click` (human mode) → includes telemetry: `{"landedAt": {x,y}, "targetBox": {...}, "moveMs": 247, "totalMs": 389}` — use it to debug "my click didn't register".

## 5. Complete command reference (verified against src/commands.js)

Daemon-level: `start` · `stop` · `status [--verbose]` · `wait-ready [--timeout=N]` · `repl` (interactive shell — human use; agents stick to one-shots)

All page commands accept `--page=<id>` and `--timeout=<ms>` (default 30000). All INTERACTION commands additionally accept `--raw=true` (skip human layer) and `--seed=<int>` (reproducible randomness).

| Group | Command | Args | Notes |
|---|---|---|---|
| Pages | `new [--label=name]` | — | opens a page in its own window, returns its stable id |
| | `pages` | — | list open pages: id, label, URL, window, `input` (pointer + held buttons/keys) |
| | `close --page=<id>` | — | close your page (releases anything it still holds) |
| Nav | `goto <url>` | url | `--waitUntil=load\|domcontentloaded\|networkidle`; human mode adds 300–2000 ms post-load idle |
| | `back` / `forward` / `reload` | — | history nav |
| Interact | `click <selector>` | selector | Bézier path + jitter; `--button=left\|right\|middle`, `--clickCount=1\|2\|3`, `--at=x,y`, `--hold=<ms>`, `--modifiers=Control,Shift` |
| | `dblclick <selector>` | selector | double-click (a real `detail:2` + `dblclick`) |
| | `rightclick <selector>` | selector | context menu click |
| | `fill <selector> <value>` | sel, value | human: triple-click clear + Ctrl+A fallback + typed cadence; works on React-controlled inputs |
| | `type <selector> <text>` | sel, text | clicks field first, then types; `--typos=on\|off\|auto` |
| | `press <key>` | key | `Enter`, `a`, `Control+A`, `Control+Shift+ArrowLeft`; `--hold=<ms>` (auto-repeat), `--repeat=<n>` |
| | `hover <selector>` | selector | human mouse path; `--at=x,y` |
| | `click-at <x> <y>` / `hover-at <x> <y>` | x, y | viewport point; `--space=css\|screenshot`, `--exact` (+ click flags) |
| | `element-at <x> <y>` | x, y | read-only hit test: tag, id, text, box, `draggable`, `editable`, `selectorHint`, iframe chain |
| | `drag <from> <to>` / `drag-at <x1> <y1> <x2> <y2>` | selectors / points | HTML5 vs pointer chosen automatically (`mode`); `--from-at`, `--to-at` |
| | `mouse-down` / `mouse-up` / `key-down <key>` / `key-up <key>` / `release` | — | holds persist across commands; `release` lets go of everything |
| | `type-focused <text>` | text | human typing into the focused element (no click) |
| | `paste <selector> <text>` / `paste-focused <text>` | text | REAL clipboard paste, falls back to typing safely; `--from-file=<path>` |
| | `select <selector> <value>` | sel, value | native `<select>`: click + arrow keys + Enter (multiple: JSON array) |
| | `scroll <up\|down\|left\|right\|top\|bottom\|px>` | dir | quantised wheel on the scroll container under the pointer; `--dx`, `--target=<sel>`, `--x --y` |
| | `calibrate-wheel` | — | record the human's own wheel (`--seconds=10`); only on `about:blank` / a local page (`new` starts there) |
| | `upload <selector> <path>` | sel, path | file input; absolute or cwd-relative path |
| | `drop-files <selector> <path>…` | sel, paths | drop local files onto a drop zone like a drag from the file manager |
| | `tap` / `tap-at` / `swipe` / `pinch` | — | touch; REFUSED unless the daemon runs with `NATIVEWRIGHT_TOUCH=1` (and that touch-only daemon REFUSES every mouse command, `--raw` too) |
| Wait | `wait <ms>` | ms | blind sleep — prefer `wait-for` |
| | `wait-for <selector>` | selector | `--state=visible\|hidden\|attached\|detached` |
| | `wait-for-load` | — | `--state=load\|domcontentloaded\|networkidle` |
| Read | `text [selector]` | sel? | inner text of element or whole body |
| | `html [selector]` | sel? | outerHTML or full document |
| | `title` / `url` | — | current page title / URL |
| | `get <selector> <attr>` | sel, attr | getAttribute |
| | `count <selector>` | selector | number of matches |
| | `eval <js>` | js | run JS in page, returns `{value}` |
| | `cookies [--url=...]` | — | domain-scoped cookie dump |
| Frames | `frame <name>` | name | scope subsequent interactions to an iframe |
| | `frame --reset` | — | clear frame scope |
| Dialogs | `dialog <accept\|dismiss> [promptText]` | action | policy for future alert/confirm/prompt |
| Artifacts | `shot [name]` | name? | PNG → artifacts dir; `--scale=device\|css`, `--selector=<sel>`, `--fullPage`; returns `dpr`, `viewport`, `imageSize`, `clip` |
| | `save-artifact [name]` | name? | PNG + HTML + metadata JSON bundle |
| | `downloads [--n=N]` | — | captured downloads with auto-saved paths |
| Diagnostics | `console [--n=N]` | — | recent console.* messages (hook re-injected per navigation) |
| | `network-log [--n=N]` | — | recent requests/responses |
| | `state` | — | pages (with `input`), idle timer, command ring buffer, `headless`, `touch` |
| | `ping` | — | liveness check |
| | `help` | — | full command list |
| Viewport | `viewport <w> <h> --force` | w, h | stealth-risky; refuses without `--force=true` |

## 6. Human-behavior layer (ON by default — that's the point)

Every interaction command routes through a realistic input synthesizer. Defaults you must know:

- `goto` pauses 300–2000 ms after load ("reading") before returning.
- `fill` clears via triple-click + Ctrl+A + Delete, THEN types at human cadence — slower than raw fill but works on React/contenteditable inputs that reject programmatic value-set.
- `type` focuses via a real mouse click first.
- Typo simulation (~0.8 %/char) is AUTO-DISABLED for password/OTP/CVV/PIN/secret/token fields (sniffs `type`/`name`/`id`/`autocomplete`).
- `scroll` stops automatically when the page can't scroll further.

**Use `--raw=true` when:** element is invisible/offscreen; pasting a secret (human-speed password typing itself looks like guessing — paste is natural); deterministic test runs; target has no anti-bot.

**Use `--seed=<int>` when:** you need reproducible paths/delays/typos across runs (debugging a flaky selector).

```
nativewright fill "#api-token" "$TOKEN" --raw=true
nativewright click ".flaky-button" --seed=42
```

### 6b. Coordinates, holds, scrolling, paste, touch (2.2)

- **Prefer selectors; use coordinates only without one.** `--space=css` (default) is `clientX/Y`; `--space=screenshot` is device pixels from a `shot` image (css = px / `devicePixelRatio`). On a 150% display raw screenshot numbers land 50% off — the errors state viewport, dpr and converted values. `element-at` first if unsure.
- **Holds persist.** `key-down`/`mouse-down` stay down across commands until `key-up`/`mouse-up`/`release`; `pages` → `input.held` shows them. Release before you finish; `close` releases too.
- **Scrolling acts on the container under the pointer.** Use `scroll … --target=<panel>` for SPAs. The wheel is quantised (default 100 px per notch): trust `scrolledBy` in the response, not the request.
- **Paste is real but safe**: it only touches an empty/plain-text clipboard and restores it; otherwise (or in headless) it types — read `method`/`reason` (and `restoreNote` if `clipboardRestored` is `false`). On Windows the payload is kept out of clipboard history/cloud sync, but never paste a secret. The machine-wide clipboard lock is held while its holder is alive (heartbeat); a waiter gives up after 10 s and types. Typing is for short texts: a fallback refuses a text over 2000 characters (headless, a busy clipboard) with an error that says how long typing would take — use a headed daemon with a plain-text clipboard, or `fill --raw=true`, for bulk text.
- **Touch is gated, and mouse is gated the other way**: touch commands are refused unless the browser reports touch support (`NATIVEWRIGHT_TOUCH=1` daemon); that daemon is touch-only (`any-pointer: fine` false), so `click`/`hover`/`click-at`/`hover-at`/`drag`/`drag-at`/`mouse-down`/`mouse-up`/`scroll`/`fill`/`type`/`select`/`paste <selector>` are refused there (also with `--raw`). Use `tap` + `type-focused`/`paste-focused`/`press`, `swipe`, `drop-files`. Never bypass either gate.
- **Wheel calibration**: only a human `calibrate-wheel` is adopted for scrolling (`wheelModel: default|human` in `state`/`status`); `--simulate` is a test hook whose profile is ignored. It puts an overlay on the page that the site's own scripts can see, so it is refused anywhere but `about:blank`, `data:`/`file:` and localhost: `nativewright new --label=calibrate`, then `calibrate-wheel --page=<id>`.
- Cyrillic/emoji in `type`/`fill`/`type-focused` just work (layout switch chord / IME-style insert).

## 7. Persistent profile

Profile (cookies, localStorage, IndexedDB) survives stop/start. Location (override: `NATIVEWRIGHT_USER_DATA_DIR`):

- Windows: `%LOCALAPPDATA%\NativeWright\profile\default\`
- macOS: `~/Library/Application Support/NativeWright/profile/default/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/nativewright/profile/default/`

Sessions on mature sites (Google, Microsoft) last ~2 weeks before device-token re-auth.

**NEVER open a normal Chrome on this profile directory** — Chrome holds a lock; a second opener fails or corrupts state. If `start` fails with a profile-lock error: stop the daemon, close all Chrome, `tasklist | findstr chrome` (Windows) / `pgrep -fl chrome` (Unix), kill leftovers, retry.

## 8. First-run login (sites that need auth)

The daemon's Chrome is a VISIBLE window. When a site needs login the profile doesn't have yet:

1. `nativewright goto "<login-url>"` — page opens in the visible Chrome.
2. STOP and ask the human operator to complete the login manually in that window (they type credentials, pass 2FA, solve captchas). Do NOT type credentials yourself unless the operator explicitly hands them to you in the task — then use `fill ... --raw=true` for the secret field.
3. After the operator confirms, verify: `nativewright url` + `nativewright text` (look for an account marker), then proceed.
4. The session persists in the profile — future runs skip this entirely.

## 9. Debugging

- `nativewright status --verbose` — last 20 commands with timings.
- `nativewright console` — captured console.log/warn/error (populated after first goto/reload/new).
- `nativewright network-log` — recent requests.
- Daemon log: `%LOCALAPPDATA%\NativeWright\logs\daemon.log` (or `$NATIVEWRIGHT_HOME/logs/daemon.log`).
- Stale lockfile (daemon.json exists, `status` says not running) → `start` auto-reaps it.

| Symptom | Cause | Fix |
|---|---|---|
| `daemon not running` | stale/missing lockfile | detached `start` + `wait-ready` |
| `ECONNREFUSED` | daemon crashed mid-command | `start` (auto-reaps lock) |
| `console` empty | no hook yet on this page | populates after first `goto`/`reload` |
| selector timeout | element not rendered yet | `wait-for <selector>`, not blind `wait` |
| profile-lock on start | another Chrome on the profile | close it, kill zombies, retry |
| `no pages open — run new first` / `N pages are open … pass --page` | no page claimed / ambiguous targeting | `nativewright new --label=…`, then pass `--page=<id>` |
| viewport rejected | stealth guardrail | add `--force=true` only if you accept the fingerprint risk |

## 10. Worked examples

**Scrape a JS-rendered page (joiner-safe):**
```
nativewright status                          # running:true → JOINER
nativewright new --label=scrape              # → page p3
nativewright goto "https://app.example.com/dashboard" --page=p3
nativewright wait-for ".data-table" --state=visible --page=p3
nativewright html ".data-table" --page=p3    # parse the JSON "result.html"
nativewright close --page=p3                 # JOINER cleanup — NOT stop
```

**Form flow with evidence (owner):**
```
nativewright status                          # running:false → OWNER
Start-Process -WindowStyle Hidden nativewright -ArgumentList 'start'
nativewright wait-ready --timeout=30000
nativewright new --label=signup              # → page p1
nativewright goto "https://example.com/signup" --page=p1
nativewright fill "input[name=email]" "user@example.com" --page=p1
nativewright select "select#plan" "pro" --page=p1
nativewright click "button[type=submit]" --page=p1
nativewright wait-for ".confirmation" --state=visible --page=p1
nativewright save-artifact signup-confirmed --page=p1   # PNG + HTML + metadata
nativewright close --page=p1
nativewright stop                            # OWNER cleanup — MANDATORY
```

**Click a point on a canvas / read the page from a screenshot (coordinates):**
```
nativewright shot map --page=p1              # → dpr, viewport, imageSize
nativewright click-at 1177 243 --space=screenshot --page=p1   # device px from the image
nativewright drag-at 300 400 500 400 --page=p1                # sliders, canvases, HTML5 drags
nativewright release --page=p1               # if you used key-down / mouse-down
```

**Read data out of an iframe:**
```
nativewright frame "checkout-frame"
nativewright text ".total"
nativewright frame --reset
```

## 11. Reference docs in this repo

- `README.md` — full project documentation.
- `claude-skills/nativewright/SKILL.md` — the canonical agent protocol (this file mirrors it for Codex).
- `claude-skills/nativewright-login-bootstrap/SKILL.md` — detailed first-run manual-login procedure.
- `src/commands.js` — source of truth for the command surface; if this file and the table in §5 ever disagree, the source wins (then update §5).
