## 0.9.1 - 2026-10-15

- Include the MIT license and an original project icon in the desktop bundle.
- Refresh runtime dependencies and require the patched MCP SDK.
- Align GitHub repository links with `mcp-linkedin-browser`.
- Rename the npm package and command to `mcp-linkedin-browser`. Install with
  `npx -y mcp-linkedin-browser@latest`.
- Update setup examples and the server identity to the canonical package name.
- Keep existing tool names, settings and stored data compatible.
- Publish future approved version tags through npm trusted publishing.

## 0.9.0 - 2026-10-08

- feat: `linkedin_get_sent_invitations` lists the connection invitations you sent
  that are still pending (name, headline, profile URL, "Sent N days ago").
- feat: `linkedin_get_connections` lists your connections, newest first, with
  `connectedDate` (YYYY-MM-DD). Together with the sent list it shows who accepted
  a request and when, which an outreach sequence needs before following up.
- fix: `linkedin_get_conversations` returned at most the ~10 threads LinkedIn
  renders first, whatever `limit` asked for. It now scrolls the inbox list to load
  more (about 20 in practice).

## Unreleased

- ci: fix the CI workflow, which had failed on every push since 0.6.0. It still
  ran `npm run typecheck:react`, a script removed along with the Electron renderer,
  so every run died with `Missing script: "typecheck:react"` before reaching the
  build or the tests.
- ci: drop `publish.yml`. Publishing from CI was abandoned back in 0.4.x — the
  granular npm token cannot bypass 2FA, so every run failed with `EOTP` — and the
  workflow fires on exactly the commits that matter (a version bump), turning each
  release red for no reason. Publishing is local, via `daily-publish`. Restoring a
  CI route would mean OIDC Trusted Publishing, which is not set up.
- fix: `npm run pack:mcpb` now copies package.json's version into manifest.json
  before packing. `npm version` knows nothing about the .mcpb manifest, so the two
  drifted: the manifest claimed 0.6.0 while the package shipped 0.7.0 — and that
  manifest version is what Claude Desktop shows for an installed extension.
- fix: `pack:mcpb` also regenerates manifest.json's `tools` from the server's own
  `TOOL_DEFINITIONS`. The hand-maintained list advertised 12 tools while the server
  exposed 21, so nine — the entire invitations surface, the messaging reads, and
  the quota tool — were invisible in the extension's listing. Each entry is the
  tool's own description trimmed to its first sentence, with " Write action."
  appended for anything the mutation gate covers, so adding a tool now updates the
  manifest for free.
- fix: type errors in the test suite (a zod raw shape's broad index signature) that
  made `npm run typecheck:test` fail; the step is back in CI now that it passes.

Note: no npm release — manifest.json and the workflows are not part of the
published tarball, so 0.7.0 on npm is unaffected.

## 0.7.0 - 2026-08-03

- feat: every mutating tool (`linkedin_send_message`, `send_connection`, `react`,
  `comment`, `accept_invitation`, `withdraw_invitation`) takes `dryRun`. It resolves
  the target, returns the exact payload that WOULD be sent, and performs nothing —
  no action, no quota charged. `LINKEDIN_ALLOW_MUTATIONS` is all-or-nothing per
  session, so once writes were enabled an agent had no way to check what it was
  about to put in a real person's inbox: the confirmation step the HITL harness has
  always given a human reviewer. A dry run is exempt from the mutation gate, since
  previewing matters most while writes are still off; every `dryRun` branch returns
  before its write call. `react`, `comment` and `withdraw_invitation` answer without
  launching Chrome at all.
- feat: the driver's typed error code now rides in the MCP error envelope, with a
  one-clause recovery hint. `needs_login`, `needs_verification`, `quota_exceeded`,
  `action_failed` and `mutations_disabled` were all flattened to an English
  sentence, so an agent had to string-match prose to tell "solve the captcha and
  retry" from "wait until midnight" from "the selector broke". Only known codes are
  echoed, so an unrelated library exposing a `.code` cannot inject one.
- feat: `linkedin_search_people`, `search_jobs`, `search_companies` and
  `get_conversations` take an optional `limit` (max 100). `get_feed`,
  `get_notifications` and `get_member_posts` already had one; these were hardcoded
  at 25-30, so asking for 5 results still cost 25 and 40 was unreachable. Defaults
  are unchanged.
- fix: the MCP handshake reports the real package version. It was hardcoded
  `1.0.0` while the package shipped 0.6.0, so every client — and every bug report
  written from what a client displayed — named a version that has never existed.

## 0.6.0 - 2026-07-28

- BREAKING: dropped the Electron desktop app. The MCP server is now standalone and drives your INSTALLED Google Chrome directly (Playwright `channel: 'chrome'`) — no separate app to install/sign/notarize, and no browser download.
- On the first LinkedIn action a visible Chrome window opens for a one-time login; the session persists under `~/.linkedin-mcp`.
- Removed src/main, src/preload, src/renderer, electron-builder config, and the app build/release scripts; the repo is now a pure MCP server. Requires Google Chrome installed.

## 0.5.2 - 2026-07-28

- fix: Windows app auto-launch — probe the NSIS install location (%LOCALAPPDATA%\Programs\LinkedIn MCP\LinkedIn MCP.exe) and the Start Menu shortcut instead of a bare app name that never resolved.
- ci: add a Release workflow (release.yml) that builds the macOS .dmg and Windows .exe installers on their native runners and packs the .mcpb, attaching all three to the GitHub Release for a pushed v* tag.

## 0.5.1 - 2026-07-28

- chore: depend on playwright-core instead of playwright — the driver only uses connectOverCDP, so no browser binary is ever needed. Fully removes the Chromium download from install (smaller, faster, airtight "no download").

## 0.5.0 - 2026-07-28

- refactor: connect-only driver — the MCP server attaches to the desktop app's browser over CDP and never launches its own Chromium; launch/headless mode removed. No more Playwright Chromium download.
- feat: standalone/npx servers auto-discover a running app (and launch one if none is running) instead of failing — the app advertises its CDP endpoint.
- feat: add linkedin_update_profile tool to edit your own profile (headline, about, first/last name, location); gated behind LINKEDIN_ALLOW_MUTATIONS.
- feat: one-click install for Claude Desktop via a .mcpb bundle (manifest.json) with a CLI-free packer (npm run pack:mcpb); write actions surfaced as a config toggle.

## 0.4.9 - 2026-07-17

- feat: add linkedin_get_messages tool to read a conversation thread

## 0.4.7 - 2026-07-14

- feat: report resetsAt (next local-midnight rollover) in the linkedin_get_quota tool

## 0.4.6 - 2026-07-13

- feat: add linkedin_get_quota MCP tool to report daily action-cap usage

