---
name: nativewright-vpn
description: Use when a site blocks or throttles you by IP address — "Daily limit reached", "more than N downloads from your IP", "too many requests", "try again in 24 hours", HTTP 429, per-IP quotas — or when a task needs a different country / IP. Routes the work into the dedicated `vpn` NativeWright profile, turns on its browser VPN (Browsec), verifies the new IP, and retries there. Never touches the default logged-in profile.
---

# NativeWright VPN

One principle: **a different IP lives in a different profile.** The default NativeWright profile holds the human's logged-in accounts and must keep one stable IP. Anything that needs another IP happens in the separate `vpn` profile — its own Chrome, own cookies, own daemon — where a browser VPN extension is installed.

Read the `nativewright` skill first; this skill only adds the VPN layer. Every command below carries `--profile=vpn`.

## When to use

- A page says something like: *"Daily limit reached. There are more than 5 downloads from your IP … during last 24 hours"*, *"Too many requests from your IP"*, *"Download limit exceeded, try again later"*, or the server answers **HTTP 429** for a per-IP quota.
- The task explicitly needs content as seen from another country.

## When NOT to use

- **CAPTCHA / "unusual traffic" / "I'm not a robot" pages.** A VPN does not solve these (shared VPN IPs usually get *more* challenges). Hand off to the human instead.
- **Login walls, paywalls, account-level limits** ("your account has reached its quota"). The limit follows the account, not the IP — a VPN changes nothing.
- **Anything in the default profile.** Never install, enable or use a VPN there. Changing the IP of logged-in Google / LinkedIn / Meta sessions mid-session is a classic trigger for security checks and bans, and the proxy would hit every other agent's page in that daemon.
- Plain HTTP fetches from the shell — those don't go through the browser at all.

## What is available

| Tool | State | Use |
|---|---|---|
| **Browsec** (`omghfjlpggmjjaagoclmmobgdodcjboh`) | installed, terms accepted, **no login needed** | **the default.** Free countries: Германия, Латвия, Литва, Великобритания, Нидерланды, Сингапур, США |
| Proton VPN (`jplgfhpmjnbigmhklmmbgecoobifkmpa`) | installed, **not logged in** | unavailable. Do not log in, do not create accounts — only the human may. |
| Windscribe (`hnmpcagpplmpfojmgmnngilcnanddlhb`) | installed, **not logged in** | unavailable, same rule. |

The `vpn` profile has **no logged-in accounts.** If the target site requires login, stop and ask the human to log in once inside the `vpn` profile (`nativewright-login-bootstrap`, adding `--profile=vpn` to every command). Never copy cookies between profiles.

**Only one VPN extension may be on at a time.** Chrome's proxy setting is browser-wide and only one extension can control it; two "connected" VPNs means one silently isn't. Only Browsec is used unless the human says otherwise.

## Hard rules

<HARD-GATE>
1. **Version guard.** `nativewright status --profile=vpn` must print `"profile": "vpn"`. If it doesn't, the installed nativewright is older than 2.1.0 and IGNORES `--profile` — every command would silently run in the DEFAULT logged-in profile. STOP and report: "nativewright < 2.1.0 — run `npm install -g nativewright@latest`".
2. **Verify, never assume.** The VPN is ON only when an IP check *from a `vpn` page* shows an IP different from the machine's real IP. Extension state survives daemon restarts and can be stale.
3. **The VPN state is shared by every page in the `vpn` profile.** Don't turn it off or change country while another agent has a page there (see "Coordination").
4. **At most 3 countries per task.** Free VPN exit IPs are shared by thousands of users and are often *already* over a site's per-IP limit. If 3 countries all hit the limit, stop and report — don't loop.
</HARD-GATE>

## Procedure

Variables: `CTL` = your VPN control page, `WORK` = your work page. Pass `--page=` on every page command (see `nativewright`).

### 1. Bring up the `vpn` profile

```bash
nativewright status --profile=vpn          # guard: must contain "profile": "vpn"
```

If `running: false`:

```
Bash(command='nativewright start --profile=vpn', run_in_background=true)
```

```bash
nativewright wait-ready --profile=vpn --timeout=40000
```

### 2. Coordination check

```bash
nativewright pages --profile=vpn
```

- If a page labelled **`vpn-ctl`** exists, another agent is changing the VPN right now — wait 30 s and re-check; don't open your own.
- If other agents' work pages exist, the VPN is in use: **don't change country or turn it off.** Skip to step 4 and use the current exit as-is. If it doesn't work for your site, wait for them to finish, or report.

### 3. Turn the VPN on (Browsec)

```bash
nativewright new --profile=vpn --label=vpn-ctl                       # → CTL
nativewright goto "chrome-extension://omghfjlpggmjjaagoclmmobgdodcjboh/popup/popup.html" --profile=vpn --page=$CTL --raw=true
nativewright get "div.FootSwitch button.Pill" aria-checked --profile=vpn --page=$CTL
```

- `"true"` → already on. `"false"` → turn it on:

  ```bash
  nativewright click "text=Включить VPN" --profile=vpn --page=$CTL
  ```

- Current country:

  ```bash
  nativewright text "div.Active_Country_Name" --profile=vpn --page=$CTL
  ```

Browsec's UI lives in **Shadow DOM**. Use `click` / `text` / `get` with selectors (Playwright locators pierce shadow roots). `eval` with `document.querySelector` and `text` without a selector return nothing there.

### 4. Verify the IP

Real IP of the machine (the shell is not proxied):

```bash
curl -s https://api.ipify.org
```

IP as the `vpn` profile sees it:

```bash
nativewright new --profile=vpn --label=<task>                        # → WORK (reuse for the actual task)
nativewright goto "https://ipwho.is/" --profile=vpn --page=$WORK --raw=true
nativewright text --profile=vpn --page=$WORK                         # JSON: ip, country, city
```

- VPN is working iff the `ip` differs from the real IP and `country` matches the selected one.
- `ERR_TUNNEL_CONNECTION_FAILED` right after turning on / switching country is normal — wait 5 s and retry. Two more failures → switch country (step 6).
- Don't use `ipinfo.io` for this: it rate-limits shared VPN IPs (`429`). `https://api.ipify.org?format=json` is a fallback (IP only, no country).

### 5. Redo the task in the `vpn` profile

```bash
nativewright goto "<the ITEM page, not the old download link>" --profile=vpn --page=$WORK
nativewright click "<download button selector>" --profile=vpn --page=$WORK
nativewright downloads --profile=vpn --page=$WORK                    # saved path (under YOUR ./artifacts/)
```

- **Start from the item/landing page.** Download links obtained in the default profile are often signed for that session or IP and won't work from the VPN.
- If the site shows the same per-IP limit again → step 6.

### 6. Switch country (max 3 per task, only if you're alone in the profile)

```bash
nativewright click "div.ChangeButton" --profile=vpn --page=$CTL
nativewright click "div.Country:text-is('Нидерланды') >> nth=0" --profile=vpn --page=$CTL
```

- Pick only free countries: **Германия, Латвия, Литва, Великобритания, Нидерланды, Сингапур, США.** The list repeats the same names further down as Premium entries — `>> nth=0` selects the free one.
- If the popup is no longer on the main screen (the `div.ChangeButton` click fails), reload it: `goto` the popup URL again.
- Then re-run step 4 before retrying the task.

### 7. Release

```bash
nativewright close --profile=vpn --page=$WORK
nativewright close --profile=vpn --page=$CTL
```

**Leave the VPN on** — the `vpn` profile exists for this; the next agent re-verifies anyway. Don't `stop` the daemon; it idle-exits when no pages remain. Turn the VPN off only if the human asks:

```bash
nativewright click "div.FootSwitch button.Pill" --profile=vpn --page=$CTL     # when aria-checked is "true"
```

## Reporting

Tell the human: which profile was used (`vpn`), the country and exit IP (from step 4), how many countries were tried, and the downloaded file path. If you stopped (3 countries failed, CAPTCHA, login needed, version guard), say exactly why.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `status --profile=vpn` has no `"profile"` field | nativewright < 2.1.0 | stop; ask the human to `npm install -g nativewright@latest` |
| IP unchanged after "on" | Browsec not actually connected, or another proxy extension holds control | re-read `aria-checked`; reload the popup; if still same, report |
| Popup shows "Принять" (terms) | terms reset (fresh profile) | accepting terms needs the human's OK — ask |
| `ERR_TUNNEL_CONNECTION_FAILED` | exit node reconnecting or down | wait 5 s, retry twice, then switch country |
| Same per-IP limit in every country | shared free exits already exhausted | stop after 3 countries, report |
| Site wants login | `vpn` profile has no accounts | ask the human for a one-time login there |
