# Broad MCP-native audit (owner: "再深入的，大范围的梳理一下 … 高收益低风险明显无副作用的直接改")

A full sweep of the whole outward surface (tools, resources, prompts, result/content/error shapes, lifecycle/state,
process model, arg/naming conventions) for CLI-legacy vs MCP-native design. Evidence gathered by three parallel
read-only sweeps; every finding re-verified independently before acting (two of the sweeps' arg reads were wrong — see
below). First-principles test per item: *does this serve an agent getting data over a protocol, or a human at a shell?*

## DONE — obvious, high-value, low-risk, no downside (applied directly, gate green 46 tests)
1. **`--flag` CLI grammar stripped from all agent-facing text.** 45 command descriptions + 54 kept-arg help strings told
   the agent shell grammar (`--wait`, `--index N`, `--yes`, `--project`). New `deCli()` in `src/sites/schema.ts`
   (`--flag` → `flag`, single hyphens/ranges untouched) applied at every projection point: arg help (`argToZod`),
   dynamic tool descriptions, `sites_search` descriptions, and the site resource. One seam, display-only.
2. **Missing tool annotations filled.** `tab_expect` → `readOnlyHint` (pure assertion), `tab_open`/`tab_claim` →
   `openWorldHint` (touch the live web), `session_finalize` → `destructiveHint` (closes tabs). Metadata only.
3. **`stdout` added to `CLI_ONLY_ARGS`.** `web/read`'s "print markdown to stdout instead of saving" is a pure terminal
   concept. **Independently rejected two sweep suggestions:** `no-progress` (help: "Skip /book/getprogress call" — a
   real API-call toggle) and `column` (eastmoney: "频道 102/101/…", a data channel selector, not a table column) — both
   kept. Verified by reading each adapter's arg help, not the name.
4. **Docs *resource* list now filters by backend/capability** (`listDocs(docCtx()).filter(available)`), matching the
   `docs_list` tool — the resource was advertising docs (e.g. `tab-lifecycle`) that don't apply to the current backend.
5. **Removed the dangling `sendResourceListChanged` on tab events.** Tabs are (deliberately) not a resource, so firing
   "resource list changed" on tab open/close made every client re-list for nothing. Browser events still relay on the
   log channel.

Net: leaner, more honest tool surface — no shell grammar in descriptions, correct read/destructive/openWorld hints,
no misleading resource churn — with zero behaviour change (executor still honours everything via defaults / the js
escape hatch; projection only hides).

## Positive findings — already MCP-native, left alone
- Images returned as real base64 image content blocks (`stripImage` / `ImageValue`), not stuffed into text.
- Logging via `sendLoggingMessage` with the `logging` capability; `process.exit`/stderr confined to the operator CLI
  and host-process paths, never the request path.
- Prompts (`browse`, `write-tool`) are genuine parameterized MCP workflow prompts, not `--help` dumps.
- Error envelope is one consistent shape `{ok:false,error:{code,message,hint?,…}}` everywhere.
- Operator commands (`setup`/`install`/`uninstall`) are terminal-only, not agent tools.
- stdio launcher keeps the channel alive across host restarts (retryable `host_unavailable`) — MCP-native resilience.

## Tradeoffs — flagged for a decision, NOT auto-changed (my recommendation in each)
1. **Kebab-case arg names** (121/491 distinct, 241 instances, 158 cmds; also inconsistent with 28 snake_case, and with
   `validateDefinition`'s own identifier rule for new tools). CLI-flag convention leaking into JSON tool-input keys;
   awkward to destructure in the `js` path (`{'note-id': …}`). *Fix:* normalize keys to snake_case in `argsToShape`
   + reverse-map in the executor. *Risk:* changes the public schema of every enabled tool and the js calling
   convention; needs a within-command collision guard (`max-pages` vs `max_pages` both exist corpus-wide). *Recommend:*
   worth doing, but it's a surface change, so your call — I'd do it next if you greenlight.
2. **Tool-list explosion** — enabling a site registers one MCP tool per command (up to ~1,332; `twitter` alone = 46).
   Mitigated already: `sites.enable` is opt-in and `site_run`+`sites_search` cover all commands with zero registration.
   *Recommend:* keep the opt-in model; optionally cap or lazily register. Low urgency.
3. **`download()` returns a host filename, not bytes/resource** (`tab.download`, only reachable via js today). Broken
   for a remote agent; screenshot already shows the fix (return base64/resource). *Recommend:* do it when we care about
   remote/download flows; needs an extension bytes-read path (moderate).
4. **Host-path args** — `tab_act.files` (upload) takes host paths; corpus download commands default to host dirs
   (`./bilibili-downloads` etc.). Fine for a local agent, broken for remote. *Recommend:* defer (dev-phase, local).
5. **Shared `'http'` runtime session** (`HTTP_SESSION='http'`) + ambient `state.selected` "current tab" — a single-user
   assumption; two remote agents on the tunnel would share tabs/js/enabled-sites. *Recommend:* this is the known
   single-user design you chose; revisit by keying sessions on identity if/when multi-agent remote is real. The ambient
   current-tab is an ergonomic win for the single-agent case (prior B2 analysis) — keep for now.
6. **`{rows, columns}` result model** — columns kept in results (load-bearing for array rows), dropped from descriptions
   already. Full record-shape migration is pervasive; low priority.
7. **Cosmetic:** `doctor`/`site_run`/`sites_search` read as CLI verbs; renaming is breaking, not worth it.
