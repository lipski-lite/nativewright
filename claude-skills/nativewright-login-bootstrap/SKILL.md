---
name: nativewright-login-bootstrap
description: Use when a site requires manual human login for the first time in the NativeWright Chrome profile, or when a previously logged-in session has expired — specifically bootstrapping Google / Microsoft / GitHub / SaaS sessions that automation cannot complete on its own. Establishes persistent login that future NativeWright runs will reuse.
---

# NativeWright Login Bootstrap

A one-off ritual that establishes a persistent logged-in session in the NativeWright Chrome profile. After this runs once per site, every future NativeWright run can drive the site as an authenticated user without re-entering credentials.

## When to use

- The target site returns a login page when NativeWright navigates there.
- A previously working logged-in flow suddenly bounces through login (session expired — Google typically re-auths every ~14 days).
- You are setting up a fresh machine and need to seed the profile with accounts.

## When NOT to use

- The site accepts API tokens or service accounts — use those instead.
- The site supports SSO and your profile already has the SSO provider logged in — just navigate; SSO should auto-complete.

## The procedure

This requires the human partner at the keyboard. You cannot log in on their behalf. The goal: open the login page in a visible window, let the human log in, confirm it worked, release the page. The profile then holds the cookies.

Because every page opens in **its own window**, this coexists with other agents' work: your login window is separate from theirs. Tell the human which window to use (the label helps).

### 1. Confirm no stray Chrome is using the profile

```bash
nativewright status
# Windows: tasklist | findstr chrome
# Unix:    pgrep -fl chrome
```

If `status` shows `running: true`, reuse it. If a regular Chrome window is open against the same profile directory, close it first.

### 2. Start the daemon if needed, then claim your page

```
Bash(command='nativewright start', run_in_background=true)
```

```bash
nativewright wait-ready --timeout=30000
nativewright new --label=login-bootstrap
# → remember the returned page id as MY_PAGE
```

### 3. Open the login URL in your window

```bash
nativewright goto "https://accounts.google.com/" --page=$MY_PAGE
# or https://github.com/login, https://login.microsoftonline.com/, etc.
```

The window is real and visible on the human partner's desktop.

### 4. Hand off to the human

Explicitly tell your human partner:

> "A Chrome window labelled `login-bootstrap` is open at the login page. Please log in manually in that window. When you're done, reply 'done' (or the equivalent) so I can verify the session persisted."

Do not proceed until they confirm.

### 5. Verify the login took

```bash
nativewright url --page=$MY_PAGE                     # should no longer be the login page
nativewright title --page=$MY_PAGE                   # should be the post-login landing
nativewright save-artifact login-ok --page=$MY_PAGE  # capture evidence
```

For Google specifically, a good cross-check is to navigate to a service that requires auth:

```bash
nativewright goto "https://myaccount.google.com/" --page=$MY_PAGE
nativewright text "h1" --page=$MY_PAGE
```

If it shows a personalized account page, login succeeded. Cite the artifact path.

### 6. Release the page — MANDATORY

<HARD-GATE>
After the login is verified, you MUST close your page before ending the task:

```bash
nativewright close --page=$MY_PAGE
```

Then, if no other agent is using the daemon, shut it down so Chrome flushes the fresh cookies/tokens to disk immediately:

```bash
nativewright stop
```

If `stop` is refused because other agents still have pages open, do **not** force it. The session is still safe: Chrome persists cookies continuously while running, and the daemon exits gracefully (a full flush) once the last page has been closed for the idle period. Never kill the daemon any other way (Ctrl+C, taskkill) — an unclean exit is the one path that can lose the new login.
</HARD-GATE>

### Logging in inside a named profile

Sessions do not carry over between profiles. To log a site in inside a named profile (e.g. the `vpn` profile used by `nativewright-vpn`), run this exact procedure with `--profile=<name>` added to EVERY command (`status`, `start`, `wait-ready`, `new`, `goto`, `close`, `stop`). The cookies then live only in that profile.

## Critical rules

- **Never open the profile in a normal Chrome window.** Chrome holds an exclusive lock on a profile directory; opening it a second time will corrupt the profile or fail loudly. The NativeWright daemon IS the owner while running.
- **Never do the login automatically.** The human does the login; the daemon just holds the resulting session.
- **Never share the profile directory.** It contains personal session tokens. Keep it local.
- **Session lifetime varies**: Google ~14 days, Microsoft ~14–90 days, GitHub months, most SaaS days-to-months. When automation starts bouncing to a login page, rerun this skill.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `start` fails with profile-lock error | something else holds the profile | close all Chrome windows, terminate any zombie processes, retry |
| Login page shows "This browser may not be secure" | the site flagged the session | the human may need to complete an extra step in the visible window |
| After login, next day it's logged out again | device binding not persisted | sometimes Google reissues a device token on second visit; repeat the bootstrap once more |
| Chrome window never appears | daemon crashed on launch | check `$NATIVEWRIGHT_HOME/logs/daemon.log`; ensure no headless env override is set |
| Human can't find the window | several agent windows open | it's the one labelled `login-bootstrap` (`nativewright pages` shows labels) |
