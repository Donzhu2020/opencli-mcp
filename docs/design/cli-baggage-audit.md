# Ablation record — what was deleted from the OpenCLI lineage, and why

Ablation here means **removal**: every element below was taken out of opencli-mcp because it existed only to
compensate for OpenCLI's process model (a short-lived CLI, a dumb extension, stdout as the only channel). The
runtime that replaces it is the design in the essence report: a resident object model at the browser's edge.

## Deleted

| Deleted | Why it was CLI baggage | What replaces it |
|---|---|---|
| Host-side interaction path: page semantics compiled to JS strings in the host and shipped as `exec` frames, `BasePage.click/fillText/typeText/setChecked/drag/scrollTo`, `target-resolver` JS, fingerprint "reidentify" rescue | The CLI had to be thin and stateless, so every action was several round-trips and every ref had to survive a *process* boundary; rescue silently retargets | **One atomic `act`** implemented once (`src/shared/act-core.ts`) and run at the runtime edge (the Chrome extension): locate → wait visible/enabled/stable → scroll → hit-test → cursor → real mouse/keyboard → settle. A missing ref is `stale_ref`; the agent re-observes (diffs make that cheap) |
| `actMode` toggle and the whole `ablation` config, `scripts/ablation.mjs` | Keeping both paths behind switches *is* the baggage | Nothing — one path |
| `bind` (attach to the active tab by domain guess) | No way to name a tab from a shell | `tab_list(user:true)` + fail-closed `tab_claim {tabId,title,url}` |
| `close-window` | CLI teardown of an automation window | `session_finalize` (agent tabs closed, user tabs released) |
| Idle-close of automation windows as the *primary* end-of-task mechanism | The CLI never knew when a task ended | Explicit finalize + transport close; idle timers remain only as a safety net |
| Owned automation *window* for interactive work | The CLI needed its own container | Agent tabs live in the user's window inside a named tab group (background, muted); adapter runs get a minimized window so they never touch the user's tab strip |
| `session_trace`, `sites_list` tools | Duplicates of resources (`opencli://session/trace`, `opencli://sites`) | Resources |
| `columns`/`defaultFormat: table|yaml|csv`, `footerExtra`, `example`, exit codes, `OPENCLI_*` env configuration, SKILL.md distribution | Terminal rendering, shell contract, no way to ship docs | `rows`+`columns` structured content; `{code,message,hint,retryable}` errors; `config.json`; instructions + resources |
| Daemon on `localhost:19825` (CLI-spawned, unauthenticated WebSocket) | The CLI needed a long-lived helper | Chrome spawns the host through Native Messaging; the only listener is authenticated MCP HTTP |
| `--session <name>` strings as user-facing identity | A shell needed a name to find its tab next time | The MCP session is the session |

## Kept on purpose (not baggage)

| Kept | Why |
|---|---|
| Adapter contract `cli({site,name,args,columns,access,strategy,func|pipeline})` and the 179-site corpus | Protocol-agnostic description of what a site needs; the value of the project |
| Pipeline engine for data-shaped commands | Simplest expression of fetch → map → filter |
| ~~`data-opencli-ref` numeric refs in the budgeted text snapshot~~ | Deleted 2026-09-18 (8ba92d9): observation converged on the aria snapshot and its eN refs — one ref space for observe, find and act |
| Command journal in the extension | Protects writes across a service-worker restart; unrelated to CLI |
| Strategy / navigateBefore / siteSession on adapters | Runtime semantics of a site, not rendering |
| Stealth JS on navigation | Anti-bot behaviour sites require |

## Still to decide with data (the tester runs these; deletion follows if the number says so)
- `tab_find` vs `tab_observe`: if agents never call find after observe, delete find.
- `site_run` vs `sites_enable`: if hosts all support `tools/list_changed`, delete `site_run`.
- Cursor overlay: keep only if humans actually watch (it costs one content-script injection per tab).

- 2026-09-18 c763a5b — OpenCLI `BasePage.getCurrentUrl` sticky URL cache: a one-command-per-process compensation; in a
  long-lived session it made `wait({url})` and `observe.url` blind to navigations. Extension backend now reads the live
  `location.href` and uses the cache only while a navigation is in flight.

- 2026-09-18 (owner directive in #mcp:89f2a6cf) — Direct CDP backend (Electron apps / remote Chrome via OPENCLI_CDP_ENDPOINT)
  and every hub/passthrough remnant deleted. The product is two things: Codex-grade step-by-step browser operation through
  the Chrome extension, and freezing explored flows into tools. One browser path means one engine, one lifecycle.
- 2026-09-18 c904d64 — Electron desktop-app adapters (OpenCLI electron-apps list + user apps.yaml) excluded from the
  registry: without the CDP backend they cannot run, and a site the runtime cannot drive must not be searchable.
