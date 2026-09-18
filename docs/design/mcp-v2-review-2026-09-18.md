# Review: our MCP v2 (2026-07-28) work

Detailed, critical review of the migration (d7426cd) + B1 output schemas (e620e9a) + B5 subscriptions (d412d19) +
B6 icons (64db8ec). Verdict: the migration itself is clean and correct; two real defects and one wrong earlier claim.

## Verified solid
- **Clean cut-over.** No `@modelcontextprotocol/sdk` (v1) references remain in `src`/`scripts`; deps are server/core/client/node 2.0.0 (zod4). Gate green (37 tests).
- **server.ts is genuinely drop-in** on v2 `McpServer` (registerTool/registerResource/registerPrompt/connect/send* all present) — zero behaviour change.
- **HTTP is the SDK's intended stateless path**: `createMcpHandler(factory) + toNodeHandler`, behind our bearer/health wrapper. Smoke-verified: a v2 HTTP client lists 15 tools and calls doctor.
- **The stateless model is wired right for a browser tool.** All HTTP requests share one runtime session (`'http'`); `createMcpServer(..., persistent:false)` per request registers no long-lived `rt` listeners and its `close()` does NOT finalize the shared session — so browser/js/tab state persists across stateless requests (handle = the shared session) and there is no per-request listener leak. Embedded stdio uses `persistent:true` (real connection, direct `send*`).
- **B5 is necessary and correct.** Under per-request servers `sendToolListChanged` can't reach clients, so `rt` 'tools-changed'/'browser-event' now publish through `handler.notify.*` (subscriptions/listen). The dynamic `sites.enable()` flow works end-to-end: shared `state.enabledSites` + notify → client re-lists → next request's fresh server has the tools.
- **B1 output schemas** use `z.object(...).catchall(z.unknown())` because the v2 **client** validates strictly and rejects extra properties; smoke-verified a call passes.
- **B6** site favicons.
- **Backwards-compatible** despite "no back-compat" being allowed: `createMcpHandler` defaults to `legacy:'stateless'`, so 2025-era clients are still served next to modern 2026-07-28.

## Real defects (ranked)

### D1 — Native confirmations are BROKEN under 2026-07-28 (corrects my earlier "B3 satisfied" claim)
`elicitApproval` (server.ts:94) calls `server.server.elicitInput(...)`. In v2 `ctx.mcpReq.elicitInput` is **deprecated and THROWS on a 2026-07-28-era request** — push-style server→client elicitation is replaced by returning `inputRequired(...)` (MRTR). It's wrapped in try/catch → returns `null` → the code falls back to the `needs_confirmation` / `confirm:true` error path. **Result: for every modern client, native confirmation prompts never appear; it silently degrades to the old confirm dance.** My earlier assessment that "elicitInput works over the stream" was wrong.
Fix: implement MRTR — the confirmation-gated tool returns `inputRequired([{ Approve/Deny enum | URL elicitation }])`; the client retries with `inputResponses`; the SDK surfaces them to the handler. This is B3 done properly (and lets us finally delete the `confirm:true` fallback for modern clients while keeping it only on the legacy path).

### D2 — The stdio proxy dropped progress + cancellation (regression I introduced in Phase A)
`proxyToHost` now does `client.callTool(params, { timeout })` with no progress forwarding and no abort propagation (I removed the v1 `onprogress`/`signal` wiring because the ctx shape changed). So a long site command's progress notifications don't reach a client that connects through the launcher, and client cancellation doesn't stop the host call. The v2 handler ctx does expose progress/abort internals; re-wire `tools/call` to forward `ctx` progress and abort.

### D3 — We still call deprecated 2026-07-28 APIs
`server.sendLoggingMessage` / `ctx.mcpReq.log` and `elicitInput` are deprecated (SEP-2577; migrate logging to stderr/OTel, elicitation to MRTR). Functional for ≥12 months but should be migrated; the log-notification path also doesn't fit the per-request model well.

## Notes (by design / low priority)
- **Per-request construction cost**: every HTTP request rebuilds the full McpServer (api + 15 tools + resources + prompts + site sync). Fine at local single-user rates; revisit only if it gets hot.
- **Single-user sharing**: all HTTP clients share the `'http'` session (same tabs). Correct for one user; two agents would share the browser. Expose browser/session as explicit handles if true multi-tenant is ever wanted.
- **B4 tasks** not done: separate `io.modelcontextprotocol/tasks` extension, no auto-managed store, needs a task-polling client to verify. Recommended deferred.

## Recommended next
1. **Fix D1 (MRTR confirmations)** — this is the real "B3", and the one user-visible correctness gap under v2.
2. **Fix D2 (proxy progress/cancel)** — restore long-op feedback and cancellation through the launcher.
3. Migrate off the deprecated logging path (D3) when convenient.
