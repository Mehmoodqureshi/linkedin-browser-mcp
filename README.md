# LinkedIn MCP

[![CI](https://github.com/Mehmoodqureshi/linkedin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mehmoodqureshi/linkedin-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40mehmoodqureshi%2Flinkedin-mcp?label=npm)](https://www.npmjs.com/package/@mehmoodqureshi/linkedin-mcp)
[![license](https://img.shields.io/npm/l/%40mehmoodqureshi%2Flinkedin-mcp?label=license)](LICENSE)

A **standalone MCP server** that drives **LinkedIn** through your **installed Google Chrome** and exposes that automation to **Claude** (Desktop, Code, or any MCP client) over stdio.

Instead of using LinkedIn's (restricted) official API, it logs in as you in a real Chrome window, keeps the session alive on disk, and lets an AI assistant call a small set of well-defined tools (view a profile, search people/jobs/companies, send a message, send a connection request, read the feed and notifications, update your own profile, etc.). You stay in control: login is manual and headed, so you complete any 2FA/captcha yourself, and your password is never stored.

**No separate app to install, no code-signing, no browser download.** The server uses Playwright's `channel: 'chrome'` to drive the Chrome you already have. On the first LinkedIn action a Chrome window opens for a one-time login; the session persists under `~/.linkedin-mcp`.

> **Requires Google Chrome installed.**

---

## What it does

- **Headed, persistent browser session.** Drives your installed Chrome with an on-disk profile, plus a portable `storageState` snapshot for fast validation and recovery. Login happens once in a visible window.
- **MCP server over stdio.** Exposes LinkedIn actions as MCP tools so any MCP client can call them. All diagnostics go to stderr so the JSON-RPC stream on stdout stays clean.
- **Rate-limit-aware automation.** Every state-changing action is paced (>= ~2s with jitter) and selectors prefer ARIA/`data-*`/semantic anchors over LinkedIn's randomized CSS classes.
- **Write actions off by default.** Message/connect/comment/react/update-profile are gated behind an explicit `LINKEDIN_ALLOW_MUTATIONS` allowlist.

---

## Quick start

**Claude Code (or any terminal MCP client):**

```bash
claude mcp add linkedin -- npx -y @mehmoodqureshi/linkedin-mcp
```

**Claude Desktop (one-click):** download `linkedin-mcp.mcpb` from Releases and **double-click it** — Claude registers the server, no config editing. Set "Enable write actions" in its config if you want writes.

**Any other MCP client (Cursor, Windsurf, Cline, VS Code, …):** add the stdio block:

```json
{ "mcpServers": { "linkedin": { "command": "npx", "args": ["-y", "@mehmoodqureshi/linkedin-mcp"] } } }
```

On the first LinkedIn action a **Chrome window opens** — log in once (2FA/captcha included) and it drives that session from then on. Write actions stay **disabled** until you opt in (see [Write actions are off by default](#write-actions-are-off-by-default)).

```bash
npx -y @mehmoodqureshi/linkedin-mcp --help      # usage + config snippet
npx -y @mehmoodqureshi/linkedin-mcp --version
```

---

## Prerequisites

- **Google Chrome** installed (the server drives it — no separate browser download).
- **Node.js 20+** and **npm** (only needed for the `npx` path; the `.mcpb` bundles its own runtime).

From a source checkout:

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # type-check only
npm run pack:mcpb   # build the .mcpb bundle (needs `zip`)
```

---

## Connecting to an MCP client

MCP clients discover servers from a JSON config — for Claude Desktop:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\\Claude\\claude_desktop_config.json`

(Claude Code: `claude mcp add`; other clients use the same `command`/`args` shape.)

### Recommended — npx (no checkout)

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/linkedin-mcp"]
    }
  }
}
```

The server drives your **installed Google Chrome** (`channel: 'chrome'`) — no separate app, no browser download. On the first LinkedIn action a Chrome window opens for a one-time login; the session persists under `~/.linkedin-mcp`.

Optional `env` overrides: `LINKEDIN_MCP_USERDATA` (data dir, default `~/.linkedin-mcp`) and `LINKEDIN_HEADLESS=1` (run Chrome headless — keep it headed for the first login).

### Windows

WSL2 is **not** required — native Windows works. One config change is, though: on Windows `npx` is `npx.cmd`, a batch shim, and MCP hosts spawn the server without a shell, which cannot execute a `.cmd`. So `"command": "npx"` fails to start. Wrap it in `cmd /c`:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@mehmoodqureshi/linkedin-mcp"]
    }
  }
}
```

Or: `claude mcp add linkedin -- cmd /c npx -y @mehmoodqureshi/linkedin-mcp`

Notes:
- **Restart the client** after editing the config.
- The MCP server keeps stdout reserved for JSON-RPC; all diagnostics go to stderr.

---

## MCP tools

All tools are namespaced `linkedin_*`. Auth/status tools work without being logged in; every data/action tool requires an authenticated session (call `linkedin_login` first).

| Tool | Arguments | Description |
| --- | --- | --- |
| `linkedin_login` | `email?`, `password?` | Opens the headed login flow. Optionally pre-fills credentials; you finish 2FA/captcha by hand. Waits for the session, then persists it. The password is never stored. |
| `linkedin_logout` | – | Clears the saved `storageState` snapshot and the profile cookies; next action needs a fresh login. |
| `linkedin_status` | – | Returns `{ status, isLoggedIn, sessionValid }`. Works before the browser is launched. |
| `linkedin_get_profile` | `profileUrl` (full URL or `/in/` slug) | Opens and scrapes a member profile: name, headline, location, about, experience, education, skills, connection count. |
| `linkedin_update_profile` | `firstName?`, `lastName?`, `headline?`, `location?`, `about?` (≥1 required) | Updates **your own** profile via the Edit intro / Edit about modals. Returns per-field outcome (updated / unchanged / failed). Write action — gated by `LINKEDIN_ALLOW_MUTATIONS`. Structured sections (experience/education/skills) not yet supported. |
| `linkedin_search_people` | `query`, `filters?` | People search; returns name, headline, location, profile URL, connection degree. |
| `linkedin_search_jobs` | `query`, `filters?` | Jobs search; returns title, company, location, posted date, easy-apply, job URL. |
| `linkedin_search_companies` | `query`, `filters?` | Company search; returns name, industry, followers, company URL. |
| `linkedin_send_message` | `profileUrl`, `message` | Sends a DM to a 1st-degree/open-profile member. Fails clearly if messaging isn't permitted. |
| `linkedin_send_connection` | `profileUrl`, `note?` (<=300 chars) | Sends a connection request, optionally with a note. Returns outcome: sent / already_sent / already_connected / unavailable. |
| `linkedin_get_sent_invitations` | `limit?` (default 50) | Lists pending invitations you sent: name, headline, profile URL, "Sent N days ago". |
| `linkedin_get_connections` | `limit?` (default 40) | Lists your connections, newest first, with `connectedDate` (YYYY-MM-DD). Shows who accepted a request and when. |
| `linkedin_get_feed` | `limit?` (1–50, default 10) | Reads home-feed posts: author, text, timestamp, like/comment counts, post URL. |
| `linkedin_get_notifications` | `limit?` (1–50, default 20) | Reads notifications: type, actor, text, timestamp, URL, read/unread. |
| `linkedin_get_conversations` | – | Lists inbox threads: participant, snippet, conversation id, timestamp, unread state. |
| `linkedin_get_messages` | `conversationId` (id or thread URL) | Reads one thread's messages in order: sender, text, timestamp. |

Each tool returns a JSON payload inside the standard MCP text-content envelope. On failure the result carries `isError: true` with an actionable message (e.g. "Not logged in to LinkedIn. Run linkedin_login…").

> The advertised `filters` schemas for the search tools are richer than the filters the driver currently applies; treat advanced filters as best-effort for now (see Known issues).

---

## Session persistence

Two cooperating layers keep you logged in across restarts:

1. **Persistent Chrome profile (primary).** The driver launches your Chrome with a dedicated on-disk profile at `<userData>/playwright-profile`. Cookies, localStorage, and IndexedDB live there and survive restarts on their own — exactly like a normal browser that "remembers" you.

2. **Portable `storageState` snapshot (secondary).** On login (and on graceful close) it also writes `<userData>/linkedin-session.json`. This gives:
   - a fast, **browser-free** "am I logged in?" check by inspecting the LinkedIn `li_at` cookie and its expiry (no browser launch required), and
   - a **recovery path**: if the profile is corrupted, a fresh context can be re-hydrated by re-injecting the snapshot's cookies via `context.addCookies(...)`.

`<userData>` is `$LINKEDIN_MCP_USERDATA` (or `$LINKEDIN_USER_DATA_DIR`), defaulting to `~/.linkedin-mcp`.

**Validity** is determined by the presence of a non-expired `li_at` cookie. A session cookie (`expires === -1`) is treated as valid. `linkedin_status` surfaces this as `sessionValid`, while `isLoggedIn` additionally confirms against the live page when a context is up.

**Logging out** (`linkedin_logout`) clears the profile cookies and deletes the snapshot, forcing a fresh manual login next time.

The session files contain live credentials-equivalent cookies — `.gitignore` already excludes `userData/`, `pw-profile/`, and any `storageState.json`. **Never commit a logged-in session.**

---

## Configuration (`.env`)

Copy `.env.example` to `.env`. All values are optional:

- `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` – optional pre-fill for auto-login. **Not recommended**; manual headed login is preferred and required for 2FA/captcha accounts.
- `LINKEDIN_MCP_USERDATA` / `LINKEDIN_USER_DATA_DIR` – override the data + Chrome-profile directory (default `~/.linkedin-mcp`).
- `LINKEDIN_HEADLESS` – set to `1` to run Chrome headless (keep it headed for the first login).
- `LINKEDIN_ALLOW_MUTATIONS` – comma-separated allowlist of write actions, or `all` (default: all writes disabled).

---

## Project layout

```
src/
  cli.ts       Standalone stdio MCP entry point (the npx bin)
  driver/      Playwright automation layer (drives your Chrome)
    browser.ts     BrowserManager (persistent context, singleton, channel: 'chrome')
    session.ts     SessionManager (storageState persist/validate/recover)
    linkedin.ts    LinkedInDriver facade (composes the action modules)
    quota.ts       Daily action-cap tracking
    types.ts       Shared normalized result types
    actions/       auth, profile, profile-edit, search, messages, connections, feed (+ common, index)
  mcp/         MCP server + tool catalog/dispatch
    server.ts
    tools.ts
    mutation-gate.ts
```

---

## Write actions are off by default

Every state-changing tool is **deny-by-default**. With `LINKEDIN_ALLOW_MUTATIONS` unset, these are refused:

`linkedin_send_message`, `linkedin_send_connection`, `linkedin_accept_invitation`, `linkedin_withdraw_invitation`, `linkedin_react`, `linkedin_comment`, `linkedin_update_profile`

Opt in with a comma-separated allowlist, or `all` / `*` for everything:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/linkedin-mcp"],
      "env": { "LINKEDIN_ALLOW_MUTATIONS": "send_message,react" }
    }
  }
}
```

Read-only tools (profiles, search, feed, notifications) always work and need no opt-in.

Allowed writes are additionally capped per day — 40 connections, 60 messages, 150 reactions, 30 comments — resetting at local midnight. Call `linkedin_get_quota` to see remaining budget.

---

## Related

- [MCP Browser Extension](https://mcp-browser-extension.vercel.app) ([chrome-mcp](https://github.com/Mehmoodqureshi/chrome-mcp)): let Claude, Cursor or any MCP agent use the Chrome you are already logged into, with a deny-all domain allowlist.

## Disclaimer

Automating LinkedIn may violate its Terms of Service and can lead to rate limiting or account restriction. Use a real, consenting account, keep volumes low, and run this only for personal, lawful purposes. You are responsible for how you use it.
