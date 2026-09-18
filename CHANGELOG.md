# Changelog

## 0.0.1 — 2026-09-18

First release. opencli-mcp is an MCP-native browser runtime for your logged-in Chrome: a Chrome-spawned native host
plus an MV3 extension, driven by agents through one object model.

**Browser operation, step by step (Codex-style)**
- One engine: Playwright's injected script runs in the extension's isolated world; observe refs (`eN`), `find`, `act`,
  site adapters and frozen tools all resolve targets through it.
- `tab.observe`: accessibility snapshot with `[ref=eN]` refs, semantic diff against the previous observe, viewport
  filter, focused element, credential redaction.
- `tab.act`: wait + act in one call — strict resolution (several matches only when one is visible), actionability
  states, scroll into view, hit-test, real CDP mouse/keyboard input, navigation wait, settle. `within` scoping,
  frame chains (same-origin, srcdoc and cross-origin OOPIF), native dialogs, console and network capture, downloads,
  file uploads through the file chooser.
- Tabs are the user's: claim by id/url/title (fail-closed), agent tab groups, cursor overlay and badges, `finalize`
  with `deliverable` / `handoff`, automatic finalize on session end; handoff tabs can be claimed back later.
- `js` code mode over the full object model (`agent.browsers`, `browser.tabs/user/capabilities`, `tab.*`, `sites`,
  `recon`, `tools`, `session`), plus a small set of typed entry tools. The API reference is generated from the
  TypeScript declarations and shipped in `browser.documentation()`.

**Freezing explored flows into tools**
- `tools.define` takes the function you just ran in `js`; `tools_compile` drafts one from the session trace —
  network-first (`tab.fetchJson`), else `tab.goto/act/expect` with the locator intent you used and the checkpoints
  you asserted; one-time refs and structural CSS are reported in `warnings`.
- Frozen tools run on the same object model and fail with structured `error.details` (step, label, state, expect).
- The OpenCLI site corpus (1200+ commands) is available through `sites.<site>.<command>()` and `site_run`.

**Hosting**
- stdio launcher for Claude Code / Cursor / Claude Desktop; loopback Streamable HTTP with a bearer token for cloud
  agents; `install` writes the Native Messaging manifest and a stable extension key; `doctor` checks the chain.
- One error model everywhere: `code`, `message`, `hint`, structured data (`docs/errors.md`).
