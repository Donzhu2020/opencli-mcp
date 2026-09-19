# Output-format & interaction review — agent-friendly first (owner: "重新思考，一定要 Agent 友好")

Re-done with agent-friendliness as the primary lens, token-efficiency second. The question is not "what's smallest" but
"what lets the agent decide its next step reliably, with one consistent pattern." That flips one of my first-pass calls.

## First principle: the agent reads the `content` text
Whatever the model acts on is the `content` block. Protocol metadata (`isError`, `structuredContent`) is rendered by
the client and may or may not reach the model prominently. So **the signal the agent needs must be IN the content, in a
shape that is identical across every tool.** Consistency and in-band signal beat terseness.

## 1. One result envelope, everywhere (the top agent-friendly win)
Today there are four success shapes: typed tools → bare object; site commands → `{ok:true,site,name,value|rows,elapsedMs}`
(`executor.ts:20`); `js` → raw value; errors → `{ok:false,error:{…}}`. An agent has to learn four patterns.
**Make it one:** every result is `{ ok: true, …data }` or `{ ok: false, error: { code, message, hint?, …data } }`.
- **Keep `ok` in-band** (revising my first pass, which said drop it). `ok` is the agent's reliable inline success signal;
  relying only on the protocol `isError` is less agent-friendly because the model reads the text, not the envelope flag.
  Mirror it to `isError` too, but the in-band `ok` stays.
- Uniform shape means one branch: `if (!r.ok) handle(r.error.code)`. Same for typed tools, site commands, and js.

## 2. `js` errors must carry the branchable envelope, not a stack string (agent-friendly gap)
`js` on error returns `Error: <name>: <message>\n<stack>` as text (`server.ts:209`). An agent driving via `js` therefore
**cannot branch on `error.code`** the way it can everywhere else — the code/hint are lost in a string. **Fix:** when the
thrown error is an `ActionError`, surface `{ ok:false, error:{ code, message, hint, …data } }` (same envelope as #1);
keep the stack only as an extra field. This closes the biggest consistency gap for the power-user surface.

## 3. Act results: keep the signal that changes the next move, drop telemetry (agent-friendly = signal, not noise)
`tab_act` returns ~13 fields (`protocol.ts:113`). Judged by "does it change what the agent does next":
- **Keep:** `ok`; `navigated` + `url` (the agent MUST know the page changed → re-observe); `matches_n` **when >1**
  (ambiguity to resolve); fill/check semantics (`verified`, `actual`, `changed`) — the agent learns if the input took;
  a minted `ref`.
- **Drop from the model view (keep in the trace for tools_compile):** `match_level` (constant `'exact'` — a lie of
  choice, pure noise), `point`, `method`, `hit`, `tag`, `visible_n`, `waitedMs`, `elapsedMs`, `timings`, `selector`.
These are debug telemetry; they don't inform the agent and they crowd out the fields that do. Leaner is *more* readable.

## 4. Actionable errors are the highest-leverage agent-friendly feature — strengthen, don't just keep
The whole point of the error envelope is self-correction. Audit every error for three things the agent needs:
- a **branchable `code`** (done — one lowercase vocabulary now),
- a **`hint` that names the next action** ("observe again for fresh refs", "scope with `within`", "call docs_get …"),
- the **structured data to act on** (`candidates` for `selector_ambiguous`, `available` for `option_not_found`,
  `failed`/`expect`/`state` for `expectation_failed`).
Gap: not every thrown error carries a `hint`. Sweep the throw sites so an agent always gets "what to do next," not just
"what went wrong." This does more for agent success than any token trim.

## 5. Token hygiene — real, and it does NOT hurt agent-friendliness
- **Compact JSON for model-facing text.** `safeStringify` pretty-prints (indent 2, `js-session.ts:174`); an LLM parses
  compact JSON equally well, so this is a free 15-30% saving on every result. Exception: the `observe` accessibility
  tree is already bespoke agent-optimized text (indentation there is structure) — leave it alone.
- **Stop double-sending `content` + `structuredContent`.** With output schemas removed, `structuredContent` is
  unadvertised and the agent reads `content`; the `js` tool is already text-only. Keep the compact `content` (the agent
  channel), drop the duplicate. Neutral for the agent, removes a 2× risk.

## 6. Minor consistency (agent-friendly polish)
- Field casing is mixed (`matches_n` snake vs `elapsedMs` camel). One convention reads more predictably; low priority.
- Keep the `observe` diff format (`~`/`+`/`removed: e3–e5`) — it is already compact and scannable; agent-friendly.

## Revised order (agent-friendly first)
1. One envelope everywhere + keep in-band `ok` (#1).
2. `js` errors emit the branchable envelope (#2).
3. Lean, signal-only act results (#3).
4. Error-hint sweep — every error says what to do next (#4).
5. Compact model-facing JSON + drop structuredContent double-send (#5).

All safe, gate-verifiable, no real Chrome. The through-line: **one predictable shape + always-actionable errors + only
the fields the agent acts on.** That is the agent-friendly optimization; the token savings come along for free.
