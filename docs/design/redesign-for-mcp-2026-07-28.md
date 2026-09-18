# opencli-mcp redesign for MCP 2026-07-28

Owner mandate: adopt the latest MCP wholesale, complete redesign, **no backward compatibility**. Principles: first
principles, critical thinking, agent-friendly, elegant architecture. This doc is the shape to review before the big cuts.

## First principle
An MCP server for a browser is a **stateful world (the user's Chrome) behind a stateless protocol**. MCP 2026-07-28 makes
that explicit: no session handshake, state travels as **server-minted handles passed as tool arguments**. Our object model
is already id-based, so the redesign is mostly *removing the implicit connection-bound session* and making every handle
first-class. Everything else (typed results, MRTR gates, tasks, subscriptions) hangs off that.

## 1. Handle model (the core change)
- The client holds handles and passes them: `browser`, `session`, `tab`, `tool`, `jsSession`. No per-connection "current
  session / selected tab" state. `state.selected` and the connection→session binding are deleted.
- Handles are server-minted, opaque, and stable: `tab_open` returns `{ tab }`; `tab_observe({ tab })`. A dropped connection
  or a second client resumes by passing the same handle. This is the resilience + multi-client win, and it is *elegant*:
  one rule (pass the handle), no hidden ambient state.
- `js` becomes `jsSession` handles too, so a js session survives reconnect.
- Runtime keys all state by handle in one registry; GC by TTL + explicit finalize (already have finalize).
- SDK gate: the true stateless transport is 2026-07-28. Design the surface handle-explicit now; the transport swaps when
  the SDK ships it. Nothing about our surface needs the old session to exist.

## 2. Typed results everywhere (output schemas)
- Every tool declares `outputSchema` (JSON Schema 2020-12) and returns `structuredContent`. observe (snapshot + diff +
  changed counts + focus), act (result + resolved target), find (entries), site_run (rows/value), sites_search (hits),
  doctor, and the **error envelope** (code/message/hint/data as a schema). Agent-friendly: the model consumes typed data,
  clients render it. Available in SDK 1.30 now.

## 3. Human-in-the-loop = one path (MRTR)
- Delete the bespoke `needs_confirmation` error + `confirm:true` re-call. One mechanism: a gate returns an input request
  and the client answers. Kinds: consequential act (Approve/Deny titled enum), origin approval, login (URL-mode → open the
  site, "done?"), CAPTCHA (hand to user), ambiguity (choose among candidates as an enum).
- SDK gate: 2026-07-28 MRTR (`InputRequiredResult`/`inputRequests`/`inputResponses`) is not in 1.30; 1.30 has
  `elicitInput`. Implement the gate through one internal `requestInput()` seam that uses elicitInput today and becomes MRTR
  on upgrade — callers never change. Critical: no `confirm:true` legacy kept (no back-compat).

## 4. Long/durable ops = tasks
- observe-until-condition, recon.discover, tools_compile freeze, slow navigation, and a new `watch` return a task handle;
  the client polls and can feed input mid-task (answer a CAPTCHA, pick a candidate). Fits step-by-step + freeze.
- SDK: 1.30 has the 2025-11-25 experimental tasks; adopt it, migrate to the 07-28 redesign on upgrade.

## 5. Live state = subscriptions (delete the ad-hoc channel)
- Replace the custom `browser-event` emit with subscribable resources: `opencli://tab/{id}/console`,
  `/network`, `/observe` (deltas), and `opencli://session/{id}/tabs` (lifecycle: created/claimed/finalized/handoff).
  Clients subscribe; humans get live views; the model pulls the cheapest next state. One notification model, not two.

## 6. Icons
- Core tools get a mark; each `<site>_<command>` tool gets the **site favicon** (fetched at enable time, cached). Delight
  + instant scannability; on-brand (we drive real sites).

## Critically rejected (do not adopt just because new)
- **Sampling** (deprecated anyway): server calling back into the model is an indirection that fights agent-friendliness —
  the agent *is* the model; the runtime should not think for it. Skip.
- **Roots** (n/a), **Logging notifications** (stderr/OTel).
- `server/discover`/version negotiation: implement to the minimum the transport needs, no more.

## Tool surface after redesign (still small, all handle-explicit + typed)
`doctor`, `browser_use` (open/claim), `tab_observe`, `tab_act`, `tab_expect`, `session_finalize`, `sites_search`,
`site_run`, `tools_compile`, `tools_define`, `docs_*`, `js`, `js_reset` — every one takes explicit handles, returns
structuredContent, gates via requestInput(), and long ones return tasks. Dynamic `<site>_<command>` unchanged in spirit.

## Sequence (each gated, committed)
1. Typed results (output schemas + structuredContent) — foundation, SDK-ready, pure upside. [start now]
2. Handle-explicit surface: remove connection-bound current-session/selected; every tool takes its handle.
3. requestInput() seam + delete confirm:true; wire elicitation kinds (act/origin/login/captcha/ambiguity).
4. tasks for the long ops.
5. subscribable resources; delete the browser-event channel.
6. favicon tool icons.
7. (SDK upgrade) stateless transport, MRTR, subscriptions/listen, cacheable results.
