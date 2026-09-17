# CLI-baggage audit — what opencli-mcp inherits from OpenCLI, and why

OpenCLI's architecture was shaped by one constraint: **every command was a short-lived process**. State had to live somewhere else (a daemon, page attributes, files), every interaction had to be a self-contained envelope, and the agent's only channel was stdout text. opencli-mcp is a resident runtime with a persistent session, a bidirectional channel and an object model. This audit lists every inherited element and decides: **keep** (still right), **reshape** (right idea, wrong place), **remove** (CLI-only).

| Element | Origin | Verdict | Reason / ablation |
|---|---|---|---|
| Page semantics compiled as JS strings in the host and shipped as `exec` frames (`BasePage` → `Runtime.evaluate`) | CLI had to be thin; extension was a dumb executor | **reshape** | Round-trips are cheap over Native Messaging (~1 ms) but *atomicity* is not: wait → hit-test → mouse → settle must happen in one debugger session or a page change between frames breaks it. `act` moves into the extension (`actMode: extension`); host mode kept only as the ablation baseline. Observation (`snapshot`) stays host-generated for now — it is pure read and its budgeted formatter is agent-oriented. |
| `data-opencli-ref` numeric refs + fingerprint rescue (`exact/stable/reidentified`) | Refs had to survive between processes | **keep** | Refs must survive between *tool calls* just the same; fingerprints are page-side state, not CLI state. Ablation: `refRescue on/off` (extension act treats a missing ref as `stale_ref`). |
| Budgeted text snapshot with `[N]` indices, `compounds` sidecar | Terminal-friendly agent output | **keep + add diff** | Codex ships AX text as a diff by default; we diff on top of OpenCLI's snapshot. Ablation: `observe.diff`, `source: dom vs ax` measured in tokens per step. |
| `--session <name>` strings, lease per session, `preferredTabId` | CLI needed a name to find its tab next time | **reshape** | The MCP session *is* the session (`mcp:<id>`); tabs are page identities on it; finalize is explicit. No user-facing session strings. |
| Owned automation **window** + idle timer that closes it | CLI could not know when a task ended | **reshape** | Interactive agent tabs live in the user's window inside a named group (Codex); end of task is `session_finalize` or transport close. Background *adapter* tabs go to a separate minimized window so they never pollute the user's tab strip. Idle timers remain only as a safety net (adapter 10 min; interactive 60 min). |
| `bind` (attach to the active tab by domain guess) | No way to name a specific tab from a shell | **remove** | Replaced by fail-closed `claim {tabId,title,url}` from `user-tabs`. |
| `close-window` | CLI teardown | **reshape** | Now an alias of `finalize([])`. |
| Command journal (idempotent execution per command id) | CLI transport retried with the same id | **keep** | Still protects writes across a service-worker restart mid-command; cost is negligible. |
| `Strategy`, `navigateBefore`, `siteSession`, `defaultWindowMode` on adapters | Runtime semantics | **keep** | These describe what a site needs (login state, persistent tab), not how a CLI prints. |
| `columns`, `defaultFormat: table/yaml/plain/csv`, `footerExtra`, `example` | Terminal rendering | **remove from surface** | Results are `rows` + `columns` as structured content; formats/footers/examples are ignored. |
| Exit codes (sysexits) | Shell contract | **remove** | Errors are `{code, message, hint, retryable}`. |
| `--timeout`, `OPENCLI_*` env vars | CLI configuration | **reshape** | Per-call `timeout` arg stays (agents need it); configuration is `~/.opencli-mcp/config.json`; `OPENCLI_CDP_ENDPOINT` kept as an override. |
| SKILL.md distributed separately (`npx skills add`) | No way to deliver docs with the tool | **remove** | Docs are server `instructions` + resources, gated by a manifest, versioned with the runtime. |
| `opencli doctor` | CLI diagnostics | **reshape** | Diagnoses the Native host / extension link and is also a tool + resource. |
| Daemon on `localhost:19825` (unauthenticated WS, CLI-spawned) | CLI needed a long-lived helper | **remove** | Chrome spawns the host; the only network listener is authenticated MCP HTTP. |
| Adapter modules importing `@jackwener/opencli/registry` | Adapter contract | **keep** | 179 sites of value; the contract is protocol-agnostic. Defined tools reuse it. |
| Pipeline engine (fetch/map/filter/limit + browser steps) | YAML-era adapters, still used by JS adapters | **keep** | Data-shaped commands are simplest as pipelines; `tools_define` accepts either. |
| Plugin hooks (`onBeforeExecute`…) | CLI plugin system | **keep (thin)** | Cheap; lets existing plugins observe runs. |
| `browser recon analyze` pattern scoring | Adapter authoring | **reshape** | Becomes `recon_discover`: static candidates (tree-sitter analyzer) + network evidence ledger, persisted into site knowledge. |

## Ablation toggles (config.json → `ablation`)

| toggle | values | measures |
|---|---|---|
| `actMode` | `extension` (default) / `host` | latency per action, failure codes, hit-test accuracy |
| `observeDiff` | true / false | tokens per observe over a 10-step task |
| `observeSource` | `dom` / `ax` | tokens, ref stability across re-renders |
| `cursor` | true / false | latency overhead; human legibility (qualitative) |
| `settleMs` | 0 / 600 | stale observations after actions |
| `adapterWindow` | `separate` / `user` | user-visible clutter, adapter success |

`scripts/ablation.mjs` runs a fixed task matrix against the live host with each toggle and prints a table (latency, state size, outcome). Run it with the tester's browser profile; do not run it against a user's real Chrome.
