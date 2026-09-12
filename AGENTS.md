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

## 3. Multi-agent protocol (claim a page, switch before every command)

The daemon is single-process with one shared `activeIndex`. Concurrent agents silently clobber each other unless each works on its own page. You usually CANNOT tell whether other agents are around — follow this protocol by default.

```
nativewright new                         → {"index": N, "url": "about:blank"}   # claim YOUR page, remember N
nativewright switch N                    # before EVERY page-operating command
nativewright goto "https://example.com"
nativewright switch N
nativewright click "button.submit"
```

`switch` costs <10 ms — pay it every time. Keep `switch + cmd` pairs back-to-back (don't interleave unrelated long work mid-flow).

Commands that DON'T need a preceding switch: `status`, `wait-ready`, `pages`, `state`, `ping`, `help`, `new`, `stop`.

**End of task:**
- OWNER → `nativewright stop`
- JOINER → `nativewright switch N` + `nativewright close-page` (removes only your page)

## 4. Output contract

Every one-shot prints JSON. Exit code 0 ⇔ `"ok": true`; exit code 1 ⇔ `"ok": false` with an `error` field. The daemon survives failed commands — on `ok:false`, diagnose immediately (`console`, `network-log`, `state`), don't restart.

Response shapes you'll see:
- `status` → `{"running": true, "pid": 1234, "port": 9377}`
- `goto` → `{"ok": true, "result": {"url": "...", "status": 200, ...}}`
- `html` → `{"ok": true, "result": {"html": "..."}}`
- `click` (human mode) → includes telemetry: `{"landedAt": {x,y}, "targetBox": {...}, "moveMs": 247, "totalMs": 389}` — use it to debug "my click didn't register".

## 5. Complete command reference (verified against src/commands.js)

Daemon-level: `start` · `stop` · `status [--verbose]` · `wait-ready [--timeout=N]` · `repl` (interactive shell — human use; agents stick to one-shots)

All page commands accept `--timeout=<ms>` (default 30000). All INTERACTION commands additionally accept `--raw=true` (skip human layer) and `--seed=<int>` (reproducible randomness).

| Group | Command | Args | Notes |
|---|---|---|---|
| Pages | `new` | — | opens fresh page, makes it active, returns index |
| | `pages` | — | list open pages with URLs |
| | `switch <index>` | index | activate another page |
| | `close-page` | — | close the ACTIVE page |
| Nav | `goto <url>` | url | `--waitUntil=load\|domcontentloaded\|networkidle`; human mode adds 300–2000 ms post-load idle |
| | `back` / `forward` / `reload` | — | history nav |
| Interact | `click <selector>` | selector | Bézier path + jitter; `--button=left\|right\|middle`, `--clickCount=1\|2\|3` |
| | `dblclick <selector>` | selector | double-click |
| | `rightclick <selector>` | selector | context menu click |
| | `fill <selector> <value>` | sel, value | human: triple-click clear + Ctrl+A fallback + typed cadence; works on React-controlled inputs |
| | `type <selector> <text>` | sel, text | clicks field first, then types; `--typos=on\|off\|auto` |
| | `press <key>` | key | `Enter`, `Control+A`, `ArrowDown`, … |
| | `hover <selector>` | selector | human mouse path |
| | `select <selector> <value>` | sel, value | `<select>` option |
| | `scroll <top\|bottom\|up\|down\|px>` | dir | real wheel ticks, auto-stops at page edge |
| | `upload <selector> <path>` | sel, path | file input; absolute or cwd-relative path |
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
| Artifacts | `shot [name]` | name? | PNG → artifacts dir |
| | `save-artifact [name]` | name? | PNG + HTML + metadata JSON bundle |
| | `downloads [--n=N]` | — | captured downloads with auto-saved paths |
| Diagnostics | `console [--n=N]` | — | recent console.* messages (hook re-injected per navigation) |
| | `network-log [--n=N]` | — | recent requests/responses |
| | `state` | — | pages, active index, command ring buffer |
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
| `no active page; run \`new\` first` | no page claimed | `nativewright new` |
| viewport rejected | stealth guardrail | add `--force=true` only if you accept the fingerprint risk |

## 10. Worked examples

**Scrape a JS-rendered page (joiner-safe):**
```
nativewright status                          # running:true → JOINER
nativewright new                             # → index 3
nativewright switch 3
nativewright goto "https://app.example.com/dashboard"
nativewright switch 3
nativewright wait-for ".data-table" --state=visible
nativewright switch 3
nativewright html ".data-table"              # parse the JSON "result.html"
nativewright switch 3
nativewright close-page                      # JOINER cleanup — NOT stop
```

**Form flow with evidence (owner):**
```
nativewright status                          # running:false → OWNER
Start-Process -WindowStyle Hidden nativewright -ArgumentList 'start'
nativewright wait-ready --timeout=30000
nativewright new
nativewright goto "https://example.com/signup"
nativewright fill "input[name=email]" "user@example.com"
nativewright select "select#plan" "pro"
nativewright click "button[type=submit]"
nativewright wait-for ".confirmation" --state=visible
nativewright save-artifact signup-confirmed  # PNG + HTML + metadata
nativewright stop                            # OWNER cleanup — MANDATORY
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
