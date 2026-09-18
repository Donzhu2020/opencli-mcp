# opencli-mcp

**An MCP-native browser runtime.** A Chrome-spawned Native Messaging host plus an MV3 extension let any MCP client — Claude Code, Cursor, Codex, Claude Desktop, or a cloud agent over a tunnel — drive the user's own logged-in Chrome through a single object model, then freeze what it explored into a reusable, API-first tool.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-native-6E56CF.svg)](https://modelcontextprotocol.io)

> 中文完整说明见 [docs/guide.zh-CN.md](docs/guide.zh-CN.md)（这是什么、为什么这样设计、怎么装、怎么接、怎么用、怎么扩展、怎么排障）。The agent-facing docs under [`docs/`](docs/) are the source of truth for behavior.

---

## What it does

opencli-mcp does two things, and only two:

1. **Operate a browser step by step, Codex-style.** Observe (a Playwright accessibility snapshot with stable `eN` refs) → act (one atomic call that waits, locates, hit-tests, dispatches real input, and settles) → expect → finalize.
2. **Freeze an explored flow into a reusable tool, API-first.** The requests a session tab triggers are captured as you go, so `tools_compile` freezes the JSON request that actually carried the data instead of scraping the DOM. The frozen tool becomes a `<site>_<command>` MCP tool.

It deliberately does *not* do: OpenCLI hub binary pass-through, Electron desktop apps, a raw CDP backend, or desktop Computer Use. Those were removed on purpose (see [`docs/design/cli-baggage-audit.md`](docs/design/cli-baggage-audit.md)).

## Why a runtime, not a CLI

A one-shot CLI process starts fresh on every call: it cannot keep a debugger attached, keep a snapshot's `eN` refs alive between calls, push progress, return images, or ask the user a question. opencli-mcp's host is launched by Chrome over Native Messaging, and its lifetime equals the extension's Native Messaging port — while that port is open, Chrome keeps the extension's service worker awake — so the bridge, the port, and the `chrome.debugger` session all stay warm together.

## Architecture

```
Chrome ──connectNative──► opencli-mcp host   (Native Messaging ⇄ extension; MCP over loopback HTTP + bearer token)
                            │  runtime: sessions · site registry (OpenCLI corpus) · recon · traces · js sessions
local MCP client ──stdio──► `opencli-mcp` launcher ──► host   (embedded runtime when Chrome is closed)
cloud agent ──authenticated tunnel──► http://127.0.0.1:19991/mcp
```

Four parts:

| Part | Location | Responsibility |
|---|---|---|
| **Extension** (MV3) | `extension/` | Native Messaging port; tab leases (claim / finalize / groups / badges / cursor); `chrome.debugger` CDP (attach lifecycle, dialogs, console, network, OOPIF); the page-side engine (Playwright's injected script running in an isolated world) |
| **Host** | `src/host/` | The Native Messaging process Chrome spawns; also serves MCP over loopback HTTP (Streamable HTTP + bearer token); `install` / `doctor` / on-disk state |
| **Launcher** | `src/launcher/` | The `opencli-mcp` command itself: a stdio MCP server that proxies to the host, or embeds a runtime when the host is not running (public site commands only, no browsing) |
| **Runtime** | `src/runtime/`, `src/api/`, `src/mcp/`, `src/sites/`, `src/recon/` | Session state, the object model, the MCP server, the `js` session, the site registry, and API discovery |

Three things are unified by design:

- **One engine.** Every locator — `observe` refs, `tab.find`, `tab.act`, a site adapter's click/fill, a frozen tool's replay — goes through the same Playwright injected script in the extension's isolated world, with one selector grammar. There is no second locator.
- **One object model.** `agent` / `browser` / `tab` / `sites` / `recon` / `tools` / `session`. The typed entry tools are just a projection of it. The [API reference](docs/api-reference.md) is generated from the TypeScript declarations.
- **One error model.** Every path (entry tools, `js`, site commands) returns the same shape: `{ ok:false, error:{ code, message, hint?, ...data } }`. Branch on `code`, never on message text. The full code families live in [`docs/errors.md`](docs/errors.md).

## Two surfaces

Everything a typed tool does, the object model does too; anything outside the core loop is done in `js`.

| Surface | What it is | Use it for |
|---|---|---|
| **Entry tools** | `doctor`, `tab_open`, `tab_claim`, `tab_observe`, `tab_act`, `tab_expect`, `session_finalize`, `sites_search`, `site_run`, `tools_compile`, `tools_define`, `docs_list`, `docs_get`, `js`, `js_reset` — plus `<site>_<command>` tools that appear when you enable a site | The core loop as single, structured calls |
| **`js`** | A persistent JavaScript session over the full object model: `agent.browsers`, `browser.tabs`, `tab.observe/act/find/evaluate/screenshot/network/dialog/frames/webmcp`, `sites.<site>.<command>()`, `recon.discover(tab)`, `tools.define/compile`. Top-level `const`/`let` persist across calls; the last expression is returned | Batching many steps, loops, conditionals, and everything not in the entry set |

The two surfaces are the same MCP server whether reached over local stdio or remote HTTP — same tools, same docs.

## Features

### Browser operation

- **`tab_act` is one atomic command at the browser's edge.** A single call locates the target (`{ref}`, `{role,name}`, `{label}`, `{text}`, `{testid}`, `{selector,nth?}`, or `{x,y}`, optionally scoped with `within` and entered through a `frame` chain), waits until it is visible, enabled and stable, scrolls it into view, hit-tests the click point, moves the cursor overlay, dispatches real mouse/keyboard input via CDP, then waits for the DOM to settle. Actions: click, dblclick, hover, focus, fill (verified), type, press, select, check/uncheck, upload, drag, scroll, back/forward/reload.
- **Observation is one thing.** `tab_observe` returns a Playwright accessibility snapshot whose `[ref=eN]` nodes are `tab_act` targets; after the first observe it returns a semantic diff when the page changed only a little. Credential field values are shown as `<redacted>`.
- **Errors are branchable.** `stale_ref`, `not_found`, `selector_ambiguous` (with candidates), `not_visible`, `not_enabled`, `intercepted` (with the blocker), `option_not_found` (with options), `page_not_loaded`, and more — see [`docs/errors.md`](docs/errors.md).

### Freezing flows into tools

- **API first.** Every session tab is captured from the moment it attaches; `tab.network.read()` is a paged log of the requests your steps triggered, plus endpoint `candidates` the page's own scripts call.
- **`recon.discover(tab)`** parses the scripts a page loaded with a JavaScript port of [jsluice](https://github.com/BishopFox/jsluice)'s ideas on web-tree-sitter (fetch/XHR/jQuery/axios/WebSocket/location usage, string concatenation resolved, unknown parts marked `EXPR`), and merges the static candidates with captured network requests into a ranked ledger.
- **`tools_compile`** drafts a tool from the session's recorded steps — network-first (a captured JSON endpoint becomes one `tab.fetchJson` call), otherwise linear `tab.goto` / `tab.act` / `tab.expect` steps that freeze the *intent* you acted with, not the element the engine happened to resolve. **`tools_define`** writes it to `~/.opencli-mcp/tools/<site>/<name>.js` and registers it live (`tools/list_changed`), no restart. See [`docs/define-tools.md`](docs/define-tools.md).

### Tabs are the user's property

- Agent-created tabs open in the background inside a Chrome tab group named after the session, muted until looked at.
- **`tab_claim`** takes over a tab the user already has open by `tabId`, or by a `url` prefix / `title` substring that matches exactly one tab (given together with a `tabId` they are guards that fail closed). Claimed tabs are never moved or closed.
- A **cursor overlay** glides to the point of each action, but only on the tab the user is actually looking at; unwatched tabs act without waiting for the animation.
- **`session_finalize`** keeps only `deliverable` (leaves the group, green badge) or `handoff` (stays in the group, yellow badge) tabs and closes the rest. If you forget, the runtime runs the same finalize when the MCP connection or session closes, or after an hour idle. See [`docs/tab-lifecycle.md`](docs/tab-lifecycle.md).

### Sites as capabilities

The OpenCLI adapter corpus ships as a library dependency (`@jackwener/opencli`): **160+ sites and roughly 1,200 commands** (Bilibili, Zhihu, Xiaohongshu, Twitter/X, Reddit, HackerNews, LinkedIn, YouTube, Amazon, GitHub, Notion, ChatGPT/Gemini/Claude web, and more). Adapters for Electron desktop apps are excluded — this runtime drives Chrome only.

They are not 1,200 tools. `sites_search` finds them; `site_run` calls any command directly without enabling it; `sites.enable(site)` in `js` loads one site's commands as typed `<site>_<command>` tools (read-only by default, `write:true` adds account-changing commands); and `sites.<site>.<command>()` works inside `js`. Under the hood a site adapter's click/fill runs on the same `act` engine as everything else.

## Requirements

- **Node.js >= 22**
- **A Chromium browser** — Chrome (incl. Beta / Canary / for Testing), Chromium, Edge, Brave, or Arc

## Install

> opencli-mcp is not published to npm yet (the registry is currently frozen; npm publishing is planned). Install from source or from a GitHub release tarball. Do not expect `npx opencli-mcp` to work yet.

### From source

```bash
git clone https://github.com/jackwener/opencli-mcp && cd opencli-mcp
npm install && npm run build
node dist/src/main.js setup     # or `opencli-mcp setup` after `npm link`
```

`setup` does the whole first run in one command:

1. Writes the Native Messaging host manifest(s), whose `allowed_origins` trusts the fixed extension ID.
2. Registers with Claude Code and Codex when their CLIs are present, and prints the standard config for every other client.
3. Opens `chrome://extensions` with the unpacked-extension path on your clipboard.
4. Waits for the extension to connect and reports green.

**The one manual step:** on the page that opens, turn on *Developer mode* → *Load unpacked* → paste the path (it is already on your clipboard). Chrome cannot load an unpacked extension for you; that click stays with the user until the extension reaches the Web Store.

Optional: `npm link` to put `opencli-mcp` on your PATH.

### From a release tarball

```bash
npm install -g ./opencli-mcp-<version>.tgz
opencli-mcp setup
```

A release also ships the extension zip (`opencli-mcp-extension-<version>.zip`): unzip it anywhere and *Load unpacked*. The extension ID is fixed by the project key in the manifest (`bpjiolaihhdecffckoljgckkcbglbpih`), so any copy — unpacked source, a release zip, or later the Web Store build — loads with the same ID, and the Native Messaging manifest only trusts that ID.

### Command reference

```
opencli-mcp                 stdio MCP (proxies to the Chrome-spawned host; embedded runtime if no host)
opencli-mcp host --native   Native Messaging host (spawned by Chrome; do not run by hand)
opencli-mcp serve [--port]  HTTP MCP + embedded runtime (for development)
opencli-mcp setup [--no-open] [--wait <seconds>]   first-run, all in one
opencli-mcp install [--browsers chrome,chromium,…] [--user-data-dir /a,/b] [--extension-id …]
opencli-mcp uninstall
opencli-mcp doctor
opencli-mcp extension-path
opencli-mcp version
```

**Custom Chrome profiles.** Chrome resolves user-level Native Messaging hosts relative to its user data dir. For a browser started with `--user-data-dir=/some/dir` (e.g. Chrome for Testing), run `opencli-mcp install --user-data-dir /some/dir`; `install` also detects a custom profile that is running right now.

**After changing the extension.** An unpacked extension is not re-read on a Chrome restart; after editing extension code, click *Reload* in `chrome://extensions` (or call `chrome.runtime.reload()`), then restart the host.

## Connecting your MCP client

### Claude Code

```bash
claude mcp add opencli-mcp -- node /path/to/opencli-mcp/dist/src/main.js
```

### Codex

```bash
codex mcp add opencli-mcp -- node /path/to/opencli-mcp/dist/src/main.js
```

(`setup` registers both of the above automatically when their CLIs are installed.)

### Cursor / Claude Desktop / any stdio client

```json
{ "mcpServers": { "opencli-mcp": { "command": "node", "args": ["/path/to/opencli-mcp/dist/src/main.js"] } } }
```

If `opencli-mcp` is on your PATH (via `npm link` or a global install), the entry is simply `{ "command": "opencli-mcp" }`.

### Cloud agents (Streamable HTTP)

The host listens on `http://127.0.0.1:19991/mcp` with `Authorization: Bearer $(cat ~/.opencli-mcp/token)`. Expose it through an **authenticated** tunnel (`ssh -R`, cloudflared, ngrok with auth) and point the agent's MCP connector at it. Never expose the port unauthenticated.

### Without Chrome

The stdio launcher embeds a runtime when the host is not running: `public` site commands work, but browsing tools return `browser_unavailable` until Chrome with the extension is connected.

## Usage

The core loop:

```
tab_open (or tab_claim) → tab_observe → tab_act → tab_observe → … → tab_expect → session_finalize
```

The same loop, batched in one `js` call (adapted from [`docs/js-tool.md`](docs/js-tool.md)):

```js
const browser = await agent.browsers.getDefault();
await browser.nameSession('🔎 research');
const tab = await browser.tabs.new('https://news.ycombinator.com');

await tab.observe();                                     // accessibility snapshot with [ref=eN] refs
await tab.act({ target: { text: 'new' }, action: 'click' });
await tab.expect({ url: '/newest' });

const titles = await tab.evaluate(
  '[...document.querySelectorAll(".titleline a")].map(a => a.textContent)'
);

// Or prefer an existing site command over raw browsing:
await sites.enable('hackernews');
const top = await sites.hackernews.top({ limit: 5 });

await browser.tabs.finalize();                           // close the agent's tabs
titles;                                                  // the value of the last expression is returned
```

The first `js` call returns the generated API reference. Model-facing discipline (build locators from the latest observe, prefer the API behind a page over its DOM, no fixed sleeps) lives in [`docs/api-use.md`](docs/api-use.md) and [`docs/instructions.md`](docs/instructions.md).

## Configuration

`~/.opencli-mcp/config.json`:

```json
{
  "port": 19991,
  "cursor": true,
  "sites": ["hackernews", "reddit"],
  "sitesWrite": [],
  "policy": { "askNewOrigins": false, "confirmWrites": false, "allowedHosts": [], "blockedHosts": [] }
}
```

- `port` — the loopback HTTP port the host serves MCP on (default `19991`).
- `cursor` — whether the cursor overlay is shown.
- `sites` / `sitesWrite` — sites enabled at startup (read-only / including write commands).
- `policy` (off by default) — `askNewOrigins` makes the first navigation to a new host return `needs_origin_approval` until `session.allowOrigin(host)` is called in `js`; `confirmWrites` makes write commands return `needs_confirmation` until re-called with `confirm:true`; `allowedHosts` / `blockedHosts` are allow/deny lists.

The state directory `~/.opencli-mcp/` also holds `token` (the HTTP bearer), `run/host.json` (the running host), `tools/<site>/<name>.js` (agent-defined tools), and the launcher script Chrome spawns. There are no environment-variable overrides — one way to do each thing.

## Repository layout

```
src/host        native messaging, bridge, HTTP (MCP transport), host entry, install, doctor, state
src/launcher    stdio launcher
src/runtime     sessions, backends, traces, policy
src/api         the object model (agent/browser/tab), diff, errors
src/mcp         MCP server (tools/resources/prompts), js session
src/sites       registry over OpenCLI adapters, executor, schema, define/compile
src/recon       analyzer (tree-sitter), discover (ledger)
src/shared      the engine (selector compilation + act orchestration), page contract
src/docs        documents manifest → instructions/resources
extension/      MV3 extension: native port, sessions/leases/groups/claim/finalize, cdp, page module, cursor+badge
docs/           agent-facing docs + design/ notes
tests/          vitest suites
```

## Development

```bash
npm run check            # gate: typecheck → build → test (must be green before every commit)
npm test                 # unit tests only
npm run build:ext        # rebuild the extension only
npm run smoke            # end-to-end over stdio with a real MCP client (embedded runtime)
npm run smoke:browser    # live browser E2E through the Chrome-spawned host
```

`docs/api-reference.md` is generated by `scripts/gen-api-reference.mjs` from the TypeScript declarations — do not edit it by hand. The page-side code is real TypeScript (`extension/src/page/`) with jsdom tests. Ablation means deletion, not a feature flag: one thing, one path.

## Documentation

- [docs/guide.zh-CN.md](docs/guide.zh-CN.md) — the full project guide (Chinese), the most complete overview
- [docs/instructions.md](docs/instructions.md), [docs/api-use.md](docs/api-use.md) — how an agent drives a page
- [docs/define-tools.md](docs/define-tools.md) — freezing a flow into a tool
- [docs/tab-lifecycle.md](docs/tab-lifecycle.md) — tab claiming, grouping, and finalize
- [docs/errors.md](docs/errors.md) — the error-code families

## License and credits

Licensed under **Apache-2.0** (see [LICENSE](LICENSE)).

- Page semantics and the site adapter corpus come from [OpenCLI](https://github.com/jackwener/OpenCLI).
- The locator engine is Playwright's injected script (Apache-2.0).
- The endpoint analyzer follows [jsluice](https://github.com/BishopFox/jsluice) (MIT).
</content>
</invoke>
