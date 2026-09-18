# opencli-mcp

**OpenCLI reborn as an MCP-native browser runtime.** One resident process, spawned by Chrome, that gives any MCP host — Claude Code, Cursor, Claude Desktop, or a cloud agent through a tunnel — a persistent object model over your *logged-in* browser, 170+ site adapters, syntax-aware API discovery, and the ability to freeze what an agent explored into a reusable tool.

```
Chrome ──connectNative──► opencli-mcp host (Native Messaging ⇄ extension · MCP over loopback HTTP, bearer token)
                            │   runtime: sessions · site registry (OpenCLI adapters) · recon · traces · js sessions
local MCP host ──stdio──► `opencli-mcp` launcher ──► host (or embedded runtime when Chrome is closed)
cloud agent ──tunnel/reverse proxy──► http://127.0.0.1:19991/mcp
```

## Why a runtime, not a CLI

A CLI process cannot keep a debugger attached, keep refs alive between calls, push progress, return images, or ask the user something. The host lives as long as the extension's Native Messaging port — Chrome keeps the service worker awake while the port is open — so the bridge, the port and the `chrome.debugger` session stay warm together.

## Two surfaces, one object model

| surface | what it is | when |
|---|---|---|
| **entry tools** | `tab_open`, `tab_claim`, `tab_observe`, `tab_act`, `tab_expect`, `session_finalize`, `sites_search`, `site_run`, `tools_compile`, `tools_define`, `docs_*`, `doctor` (+ enabled site commands as `<site>_<command>`) | the core loop as single structured calls |
| **`js`** | persistent JavaScript session: `agent.browsers`, `browser.tabs`, `tab.observe/act/evaluate/screenshot`, `sites.<site>.<command>()`, `recon.discover(tab)`, `tools.define()` | batching many steps in one call; loops; conditionals |

`tab_act` is **one atomic command at the browser's edge** (`src/shared/engine.ts`, Playwright's injected script running in the extension's isolated world): locate (`{ref}`, `{role,name}`, `{label}`, `{text}`, `{testid}`, `{selector,nth?}`, `{x,y}`) → wait until visible, enabled and stable → scroll into view → hit-test the click point → cursor overlay → real mouse/keyboard via CDP → wait for the DOM to settle. Actions: click, dblclick, hover, focus, fill (verified), type, press, select, check/uncheck, upload, drag, scroll, back/forward/reload. Errors are branchable codes (`stale_ref`, `not_found`, `selector_ambiguous` with candidates, `not_visible`, `not_enabled`, `intercepted` with the blocker, `option_not_found` with options, `page_not_loaded`). `tab_observe` returns a diff when the page changed only a little.

## Tabs are the user's property

Agent tabs open in the background inside a Chrome tab group named after the session (`tab_open {session}` / `browser.nameSession()`), muted until looked at. `tab_claim` takes over a tab the user already has open by `tabId`, or by a `url` prefix / `title` substring that matches exactly one tab (given together with a `tabId` they are guards that fail closed); claimed tabs are never moved or closed. `session_finalize` keeps only `deliverable` (leaves the group, green badge) or `handoff` (stays in the group, yellow badge) tabs and closes the rest. A cursor overlay glides to the point of each action on visible tabs.

## Sites as capabilities

The OpenCLI adapter corpus ships as a library dependency (`@jackwener/opencli`): 160+ sites, ~1200 commands (Bilibili, Zhihu, Xiaohongshu, Twitter/X, Reddit, HackerNews, LinkedIn, YouTube, Amazon, GitHub, Notion, ChatGPT/Gemini/Claude web…). Adapters for Electron desktop apps are excluded — this runtime drives Chrome only. They are not 1200 tools: `sites_search` finds them, `sites.enable(site)` (in `js`) loads one site's commands as typed tools (read-only by default; `write:true` adds account-changing commands), `site_run` calls any command directly, and `sites.<site>.<command>()` works inside `js`.

## Recon and freezing flows into tools

`recon.discover(tab)` (in `js`) parses the scripts a page loaded (a JavaScript port of jsluice's ideas on web-tree-sitter: fetch/XHR/jQuery/axios/WebSocket/location usage, string concatenation resolved, unknown parts marked `EXPR`) and merges the candidates with captured network requests into a ledger. `tools_compile` drafts a tool from the session's recorded steps; `tools_define` writes it to `~/.opencli-mcp/tools/<site>/<name>.js` and registers it live (`tools/list_changed`).

## Install

中文全览与使用指南：[docs/guide.zh-CN.md](docs/guide.zh-CN.md)。Releases: https://github.com/jackwener/opencli-mcp/releases

```bash
git clone https://github.com/jackwener/opencli-mcp && cd opencli-mcp
npm install && npm run build
node dist/src/main.js setup            # one go: host manifest + extension key, prints the MCP config for your client (any client),
                                       # opens chrome://extensions with the extension path on your clipboard, waits until connected
```

The only manual click: **Load unpacked** on the page that opens (Developer mode on), paste the path — or unzip the `opencli-mcp-extension-<version>.zip` from a release anywhere and load that. The extension ID is fixed by the key in the manifest, so any copy connects. Or step by step: `install` → `extension-path` → load it → `doctor`. Optional: `npm link` to get `opencli-mcp` on PATH.

### Claude Code
```bash
claude mcp add opencli-mcp -- node /path/to/opencli-mcp/dist/src/main.js
```
### Cursor / Claude Desktop / any stdio host
```json
{ "mcpServers": { "opencli-mcp": { "command": "node", "args": ["/path/to/opencli-mcp/dist/src/main.js"] } } }
```
### Cloud agents (Streamable HTTP)
The host listens on `http://127.0.0.1:19991/mcp` with `Authorization: Bearer $(cat ~/.opencli-mcp/token)`. Expose it through an authenticated tunnel (`ssh -R`, cloudflared, ngrok with auth) and point the agent's MCP connector at it. Never expose the port unauthenticated.

### Without Chrome
The stdio launcher embeds a runtime when the host is not running: `public` site commands work; browsing needs Chrome with the extension.

## Configuration (`~/.opencli-mcp/config.json`)
```json
{ "port": 19991, "cursor": true, "sites": ["hackernews", "reddit"], "sitesWrite": [] }
```

## Development
```bash
npm test                 # unit tests
node scripts/smoke.mjs           # end-to-end over stdio with a real MCP client (embedded runtime)
node scripts/smoke-browser.mjs   # live browser E2E through the Chrome-spawned host
npm run build:ext        # rebuild the extension only
```

## Layout
```
src/host        native-messaging, bridge, http (MCP transport), host entry, install, doctor, state
src/runtime     sessions, backends, traces
src/api         the object model (agent/browser/tab), diff, errors
src/mcp         MCP server (tools/resources/prompts), js session
src/sites       registry over OpenCLI adapters, executor, schema, define/compile
src/recon       analyzer (tree-sitter), discover (ledger)
src/docs        documents manifest → instructions/resources
extension/      MV3 extension: native port, sessions/leases/groups/claim/finalize, cdp, journal, identity, cursor+badge content script
docs/           agent-facing docs
```

Apache-2.0. Page semantics and site adapters come from [OpenCLI](https://github.com/jackwener/OpenCLI); the endpoint analyzer follows [jsluice](https://github.com/BishopFox/jsluice) (MIT).

## Ablation record
See docs/design/cli-baggage-audit.md for what was deleted from the OpenCLI lineage and why.

## Policy shapes (off by default)
`~/.opencli-mcp/config.json` → `"policy": { "askNewOrigins": true, "confirmWrites": true, "allowedHosts": ["example.com"], "blockedHosts": [] }`. With `askNewOrigins`, the first navigation to a new host returns `needs_origin_approval` until `session.allowOrigin(host)` is called in `js`; with `confirmWrites`, write site commands return `needs_confirmation` until re-called with `confirm:true`. Denials carry `retryable`; a non-retryable denial must not be bypassed by another path. Page content and page-registered (WebMCP) tools never authorize consequential actions.

## Custom Chrome profiles
Chrome looks up user-level Native Messaging hosts relative to its user data dir. For a profile started with `--user-data-dir=/some/dir`, run `opencli-mcp install --user-data-dir /some/dir`.
