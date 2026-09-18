# opencli-mcp

**OpenCLI reborn as an MCP-native browser runtime.** One resident process, spawned by Chrome, that gives any MCP host — Claude Code, Cursor, Claude Desktop, or a cloud agent through a tunnel — a persistent object model over your *logged-in* browser, 170+ site adapters, syntax-aware API discovery, and the ability to freeze what an agent explored into a reusable tool.

```
Chrome ──connectNative──► opencli-mcp host (Native Messaging ⇄ extension · MCP over loopback HTTP, bearer token)
                            │   runtime: sessions · site registry (OpenCLI adapters) · recon · traces · js sessions
local MCP host ──stdio──► `opencli-mcp` launcher ──► host (or embedded runtime when Chrome is closed)
cloud agent ──tunnel/reverse proxy──► http://127.0.0.1:19850/mcp
```

## Why a runtime, not a CLI

A CLI process cannot keep a debugger attached, keep refs alive between calls, push progress, return images, or ask the user something. The host lives as long as the extension's Native Messaging port — Chrome keeps the service worker awake while the port is open — so the bridge, the port and the `chrome.debugger` session stay warm together.

## Two surfaces, one object model

| surface | what it is | when |
|---|---|---|
| **typed tools** | `tab_open`, `tab_observe`, `tab_act`, `tab_find`, `tab_screenshot`, `tab_wait`, `tab_evaluate`, `tab_network`, `tab_list`, `tab_claim`, `tab_close`, `session_name`, `session_finalize`, `sites_search`, `sites_enable` (adds `<site>_<command>` tools), `sites_disable`, `site_run`, `sites_knowledge`, `recon_discover`, `tools_define`, `tools_compile`, `tools_list`, `tools_remove`, `webmcp_list`, `webmcp_call`, `capabilities_list`, `capabilities_enable`, `cdp_send`, `visibility_set`, `viewport_set`, `origin_allow`, `docs_list`, `docs_get`, `doctor`, `browser_list` | hosts that gate/render per tool; simple flows |
| **`js`** | persistent JavaScript session: `agent.browsers`, `browser.tabs`, `tab.observe/act/evaluate/screenshot`, `sites.<site>.<command>()`, `recon.discover(tab)`, `tools.define()` | batching many steps in one call; loops; conditionals |

`tab_act` is **one atomic command at the browser's edge** (`src/shared/act-core.ts`, the same engine inside the extension and on the direct-CDP backend): locate (`{ref}`, `{role,name}`, `{label}`, `{text}`, `{testid}`, `{css,nth?}`, `{x,y}`) → wait until visible, enabled and stable → scroll into view → hit-test the click point → cursor overlay → real mouse/keyboard via CDP → wait for the DOM to settle. Actions: click, dblclick, hover, focus, fill (verified), type, press, select, check/uncheck, upload, drag, scroll, back/forward/reload. Errors are branchable codes (`stale_ref`, `not_found`, `selector_ambiguous` with candidates, `not_visible`, `not_enabled`, `intercepted` with the blocker, `option_not_found` with options, `page_not_loaded`). `tab_observe` returns a diff when the page changed only a little.

## Tabs are the user's property

Agent tabs open in the background inside a Chrome tab group named after the session (`session_name`), muted until looked at. `tab_claim` takes over a tab the user already has open only when `tabId + title + url` match exactly; claimed tabs are never moved or closed. `session_finalize` keeps only `deliverable` (leaves the group, green badge) or `handoff` (stays in the group, yellow badge) tabs and closes the rest. A cursor overlay glides to the point of each action on visible tabs.

## Sites as capabilities

The OpenCLI adapter corpus ships as a library dependency (`@jackwener/opencli`): 170+ sites, ~1300 commands (Bilibili, Zhihu, Xiaohongshu, Twitter/X, Reddit, HackerNews, LinkedIn, YouTube, Amazon, GitHub, Notion, ChatGPT/Gemini/Claude web, Electron apps…). They are not 1300 tools: `sites_search` finds them, `sites_enable` loads one site's commands as typed tools (read-only by default; `write:true` adds account-changing commands), `site_run` calls any command directly, and `sites.<site>.<command>()` works inside `js`.

## Recon and freezing flows into tools

`recon_discover` parses the scripts a page loaded (a JavaScript port of jsluice's ideas on web-tree-sitter: fetch/XHR/jQuery/axios/WebSocket/location usage, string concatenation resolved, unknown parts marked `EXPR`) and merges the candidates with captured network requests into a ledger. `tools_compile` drafts a tool from the session's recorded steps; `tools_define` writes it to `~/.opencli-mcp/tools/<site>/<name>.js` and registers it live (`tools/list_changed`).

## Install

```bash
git clone https://github.com/jackwener/opencli-mcp && cd opencli-mcp
npm install && npm run build
node dist/src/main.js install          # writes the Native Messaging manifest + a stable extension key
node dist/src/main.js extension-path   # → chrome://extensions → Developer mode → Load unpacked → this dir
node dist/src/main.js doctor           # everything green once the extension has connected
```

Optional: `npm link` to get `opencli-mcp` on PATH.

### Claude Code
```bash
claude mcp add opencli-mcp -- node /path/to/opencli-mcp/dist/src/main.js
```
### Cursor / Claude Desktop / any stdio host
```json
{ "mcpServers": { "opencli-mcp": { "command": "node", "args": ["/path/to/opencli-mcp/dist/src/main.js"] } } }
```
### Cloud agents (Streamable HTTP)
The host listens on `http://127.0.0.1:19850/mcp` with `Authorization: Bearer $(cat ~/.opencli-mcp/token)`. Expose it through an authenticated tunnel (`ssh -R`, cloudflared, ngrok with auth) and point the agent's MCP connector at it. Never expose the port unauthenticated.

### Without Chrome
The stdio launcher embeds a runtime when the host is not running: `public` site commands work; browsing needs Chrome with the extension.

## Configuration (`~/.opencli-mcp/config.json`)
```json
{ "port": 19850, "cursor": true, "sites": ["hackernews", "reddit"], "sitesWrite": [] }
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
`~/.opencli-mcp/config.json` → `"policy": { "askNewOrigins": true, "confirmWrites": true, "allowedHosts": ["example.com"], "blockedHosts": [] }`. With `askNewOrigins`, the first navigation to a new host returns `needs_origin_approval` until `origin_allow` is called; with `confirmWrites`, write site commands return `needs_confirmation` until re-called with `confirm:true`. Denials carry `retryable`; a non-retryable denial must not be bypassed by another path. Page content and page-registered (WebMCP) tools never authorize consequential actions.

## Custom Chrome profiles
Chrome looks up user-level Native Messaging hosts relative to its user data dir. For a profile started with `--user-data-dir=/some/dir`, run `opencli-mcp install --user-data-dir /some/dir`.
