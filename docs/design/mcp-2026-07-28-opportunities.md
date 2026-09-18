# MCP 2026-07-28 — what it opens up for opencli-mcp

Researched the live spec (modelcontextprotocol.io). Current revision is **2026-07-28** (previous: 2025-11-25, 2025-06-18).
Our installed SDK is `@modelcontextprotocol/sdk` **1.30.0**, which is still the handshake era — so the wire-level 2026
changes need the SDK to catch up; the higher-level features are usable now. Split below by that.

## The 2026-07-28 headline changes
- **Stateless protocol.** No `initialize` handshake, no `Mcp-Session-Id`. Every request carries its protocol version +
  client capabilities in `_meta`. Cross-call state = **server-minted handles passed as ordinary tool args**.
- **`server/discover`** (mandatory RPC): versions + capabilities + identity in one call.
- **Multi Round-Trip Requests (MRTR)** replaces server-initiated requests (elicitation / sampling / roots). A tool returns
  `InputRequiredResult` (`resultType:"input_required"`) with `inputRequests`; the client retries with `inputResponses`.
- **Tasks extension** (`io.modelcontextprotocol/tasks`): long/durable ops via `tasks/get` polling + `tasks/update`
  (client→server input mid-task); servers may return task handles unsolicited.
- **`subscriptions/listen`**: one long-lived stream for opted-in change notifications (tools/prompts/resources/resource
  subscriptions).
- **CacheableResult** (`ttlMs`, `cacheScope`) on list/read results; **deterministic tool order** for prompt-cache hits.
- **Output schemas / structuredContent** loosened to full JSON Schema 2020-12.
- **Icons** for tools/resources/prompts (since 2025-11-25).
- **Resource links** in tool results (since 2025-06-18).
- **Deprecated: Roots, Sampling, Logging** (migrate: LLM APIs directly; stderr/OpenTelemetry). **OpenTelemetry** trace
  context conventions in `_meta`.

## Opportunities for a browser runtime, ranked

### Tier 1 — changes the product, strong fit
1. **Human-in-the-loop becomes protocol-native (MRTR).** Today confirmations are an ad-hoc `needs_confirmation` error →
   re-call with `confirm:true`, and login/CAPTCHA is "tell me when done". MRTR is exactly this pattern, first-class: a
   consequential act (send/purchase/delete), an origin approval, a login, or a CAPTCHA returns `input_required` with a
   typed request (a titled Approve/Deny enum, a text prompt, or a URL-mode elicitation to sign in), and the client renders
   native UI and retries. Removes our bespoke confirm plumbing and makes every gate a clean, cancellable prompt. Highest-fit
   item: it is the confirmations doc, done the protocol's way. (Needs SDK MRTR support.)
2. **Tasks for long/durable browser work.** A frozen site command, `recon.discover`, a slow navigation, or "watch this page
   until X" return a task handle immediately; the client polls `tasks/get` and can `tasks/update` to feed input mid-flight —
   e.g. answer a CAPTCHA that appeared, or disambiguate a locator — without restarting the call. Fits "step by step" and
   unlocks background/async exploration and long freezes. (Needs SDK tasks extension.)
3. **Stateless + explicit handles = resilience and multi-client.** MCP is now stateless; state travels as server-minted
   handles. Our object model is already id-based (`session.id`, tab `page` ids, defined tools). Making those first-class
   handles the client passes means a dropped connection or a second client resumes the same browser session/tabs — today
   we key runtime state to the MCP connection. Big robustness/UX win and aligns with what we already are. (Needs the SDK's
   stateless transport.)

### Tier 2 — real optimizations, mostly usable sooner
4. **Output schemas + structuredContent for the core tools.** `tab_observe`, `tab_act`, `tab_find`, `site_run`,
   `sites_search`, the error envelope all have clear shapes. Declaring JSON-Schema output makes results typed, validated,
   and richly renderable by clients, and lets the model consume them without parsing prose.
5. **`subscriptions/listen` for live browser streams.** Push a tab's console, network capture, observe deltas, and tab
   lifecycle (claimed/finalized/handoff) as subscriptions. Turns "watch" use cases and human visibility into first-class
   pushed streams instead of polling.
6. **Cacheable tool list + deterministic order.** With dynamic `<site>_<command>` tools appearing/disappearing, returning
   `ttlMs`/`cacheScope` and a stable order lets clients cache the list and improves LLM prompt-cache hits — a direct
   token/latency saving.
7. **Icons on tools (favicons!).** MCP lets a server attach icons to tools. Give the browser tools a mark and — the fun
   one — give each `<site>_<command>` tool the **site's favicon**. On-brand since we drive real sites, and instantly
   scannable in the client's tool list.

### Tier 3 — hygiene / observability
8. **`server/discover` + request-level version negotiation** — modernize the transport, prerequisite for the stateless model.
9. **OpenTelemetry trace context in `_meta`** (traceparent/tracestate/baggage) propagated host→extension→CDP for
   end-to-end tracing of a browse; complements our own trace.
10. **Resource links for big payloads** — return screenshots, the trace, and the network log as resource links instead of
    inline blobs.
11. **Confirm we're off deprecated features** — we don't use Roots; logging already goes to stderr; we don't depend on
    Sampling. Good.

## Feasibility gate
The Tier-1 items (MRTR, tasks, stateless, server/discover, subscriptions/listen) are 2026-07-28 wire features; SDK 1.30.0
predates them. Plan: adopt Tier-2 now where the SDK allows (output schemas, icons, resource links, cacheable/deterministic
list), and design Tier-1 against the new patterns so we're ready when the SDK ships them (or track the SDK and upgrade).
Nothing here is blocked by our own architecture — our id-based object model is already the right shape for stateless+handles.

## Suggested first moves (if owner wants to act)
- A: give the core tools output schemas + structured content (usable now, pure upside).
- B: favicons as site-tool icons (usable now, delightful).
- C: design the MRTR confirmation flow (replaces confirm:true) and the tasks-based long-op flow, behind an SDK-version check.
