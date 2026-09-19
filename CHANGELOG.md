# Changelog

## 0.0.8 — 2026-09-19

- **The client channel survives host restarts (fix "Transport closed").** The Chrome-spawned host dies whenever the
  extension's Native port drops (an extension reload/update, a crash, or the service worker being replaced). The stdio
  launcher used to exit on that drop, permanently killing the client's MCP channel (Codex/Claude don't auto-reconnect a
  dead server). The launcher now keeps the channel up and reconnects to the host on demand — re-reading the fresh
  port/token a respawned host writes — and returns a retryable `host_unavailable` while the host is briefly down.
  Combined with the extension's existing auto-reconnect, the channel self-heals after a reload instead of going
  "Transport closed". See docs/design/host-resilience-2026-09-19.md for the architecture review behind this.

## 0.0.7 — 2026-09-19

- **Fix a CSP error on strict sites.** The favicon-badge feature rewrote the page favicon to a `data:` SVG, which pages
  with a strict `img-src` CSP (e.g. Hacker News) block — logging a Content-Security-Policy violation from the content
  script on every such page. Removed the favicon badge (it was decorative; agent tabs are marked by the named tab group
  and the cursor overlay). Reload the extension to clear existing errors.

## 0.0.6 — 2026-09-19

- **We own the site corpus.** The OpenCLI adapter corpus (1387 adapters + manifest) and its runtime are vendored into
  `vendor/opencli/` and consumed via a local `file:` dependency — git-tracked and editable, no pull from upstream.
- **One engine, no shadow.** `ExtensionPage` no longer extends OpenCLI's `CDPBasePage`; every adapter now runs on the
  single Playwright injected-script engine (the second locator/AX engine is gone). The corpus-used methods (wait,
  autoScroll, interceptors, fetchJson, snapshot→aria, …) are served on our transport.
- **Agent-friendly output formats.** One result envelope everywhere — `{ok:true,…}` / `{ok:false,error:{code,message,
  hint?,…}}` with an in-band `ok`; `js` errors now carry the same branchable envelope; `tab_act` returns only what
  changes the next move (full telemetry stays in the trace); every actionable error carries a next-step hint; results
  are compact JSON and no longer double-sent as structuredContent.
- **Leaner startup.** The always-on instructions bundle is ~21% smaller (mechanics moved to on-demand docs; safety
  de-duplicated; the site catalogue is now a lookup doc) with no capability or safety content lost.
- **New icon.**

## 0.0.5 — 2026-09-19

- **MCP 2026-07-28 (v2 SDK).** Migrated to `@modelcontextprotocol/server`/`core`/`client`/`node` 2.0.0: stateless HTTP
  via `createMcpHandler`, subscription-bus list-changed notifications, output schemas, and tool icons.
- **Native confirmations via MRTR.** Human-in-the-loop for write site commands now uses `input_required`
  (multi-round-trip): the tool call pauses, the client collects the user's approval, and it resumes — one handler serves
  both protocol eras. Replaces the elicitation path that threw under 2026-07-28.
- **Progress & cancellation** are forwarded again through the stdio launcher for long browser ops (and restored for
  site commands).
- **Signer/replay hook for signed endpoints.** `tab.cookie(name)` reads a per-request token at replay; `tools_compile`
  re-reads csrf/xsrf headers from the cookie automatically and names computed signatures (wbi, x-s) in a warning instead
  of freezing dead values.
- **One error vocabulary.** Corpus/adapter error codes are normalized to the object model's lowercase families, so a
  model branches on a single vocabulary.
- **Leaner by design.** Removed dead/over-built machinery found in a first-principles audit: the unused docs-gating
  subsystem, a recon secret scanner, the single-browser "fleet" API, dead tab-mark methods, an unused hooks system, and
  stealth injection on every navigation (a no-op driving the user's own Chrome). Recon no longer runs as a hidden side
  effect of reading network requests; docs are memoized; the cursor overlay never blocks input; the write policy is
  in-memory only.

## 0.0.4 — 2026-09-18

- **API-first freezing.** Every session tab is captured from attach; `tools_compile` freezes the JSON request that
  actually carried the data (method, contract headers and body, inputs parameterized; per-request tokens and credentials
  are named, not frozen) instead of scraping the DOM, and falls back to UI steps with an explanation. `recon.discover`
  candidates are returned by `tab.network.read()` by default. Captured evidence lives in its own bounded store, never in
  the step trace.
- **Stable observe refs.** `eN` refs are pinned to the element and survive a node inserted above them, so a held ref does
  not break and the diff stays clean.
- **One transport.** Local and remote clients use the same loopback HTTP endpoint with a bearer token; default port 19991.
- **One-command, client-agnostic setup.** `opencli-mcp setup` writes the host manifest, registers with Claude Code and
  Codex when their CLIs are present, prints the standard config for any other client, and opens `chrome://extensions`.
- **New extension icon.**
- **Hardening (architecture review).** Frozen-tool code generation is injection-safe; the network dedup key is stable and
  bounded; the stable-ref map is pruned everywhere; harvesting can never fail a step; the site executor reads the error
  envelope at its real shape; dead fields and stale docs removed.

## 0.0.3 — 2026-09-18

- The extension ID is fixed by the project: the public key lives in `extension/manifest.json`, so the ID is
  `bpjiolaihhdecffckoljgckkcbglbpih` on every machine (and will stay so on the Chrome Web Store). The per-machine key
  file, manifest patching and build-time key preservation are gone. Releases ship an extension zip that can be loaded
  from anywhere.
- `setup` prints the standard MCP configuration for any client instead of registering with one.
- Default port 19991; local and remote clients use the same loopback HTTP endpoint with a bearer token.

## 0.0.2 — 2026-09-18

- `opencli-mcp setup`: the first run in one command — writes the host manifests and the stable extension key, prints
  the MCP configuration any client accepts (stdio command, or the HTTP endpoint and token location), opens
  chrome://extensions with the unpacked-extension path on the clipboard, and waits until the extension connects.
- One home: the `OPENCLI_MCP_HOME` / `OPENCLI_MCP_TOOLS_DIR` overrides are gone; state is `~/.opencli-mcp`, defined
  tools live in `~/.opencli-mcp/tools`, the extension build keeps the key from the existing dist manifest.
- Chinese project guide `docs/guide.zh-CN.md` (architecture, install, hosting, usage, lifecycle, freezing flows,
  configuration, troubleshooting, development and release).
- README: stale `css` target and `session.name()` mentions removed.

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
