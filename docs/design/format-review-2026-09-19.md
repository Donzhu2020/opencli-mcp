# Output-format & interaction review (owner: "返回 JSON / 错误码 / 格式交互细节，深入想一下")

What the agent actually reads back from every tool: the JSON text, the error envelope, the act/observe shapes. Goal:
token efficiency, consistency, agent-readability. Ranked by impact (token cost × call frequency). Grounded in code.

## 1. `tab_act` returns ~13 telemetry fields; the model needs ~3 (highest impact — act is the hottest tool)
`src/protocol.ts:113` (ActResult) → surfaced via `tab_act` `ok({ tab, action, target, ...r, ok:true })` (`server.ts`).
Every action returns: `kind, ref, matches_n, visible_n, match_level, point{x,y}, method, hit, tag, waitedMs, elapsedMs,
timings{resolveMs,actionMs,settleMs}, selector, ok` + `action, target`. The model acts on almost none of it:
- `match_level` is **hardcoded `'exact'`** everywhere (one engine) — a constant, pure noise on every act.
- `point`, `method`, `hit`, `tag`, `waitedMs`, `elapsedMs`, `timings`, `visible_n`, `selector` are debug/telemetry.
- The model needs: did it work (already the protocol `isError`), `matches_n` **only when >1** (ambiguity), and a
  minted `ref` when relevant.
**Recommendation:** return a lean act result to the model — `{ action, ...(matches_n>1 && {matches_n}), ...(ref && {ref}) }`
(+ `navigated`/`url` when it navigated). Keep the full telemetry only in the trace (tools_compile) / structuredContent,
not in the model text. Biggest single token win.

## 2. All model-facing JSON is pretty-printed (indent 2) — ~15-30% wasted tokens everywhere
`safeStringify(v, limit) → JSON.stringify(v, …, 2)` (`js-session.ts:174`), used by `ok()` (`server.ts:48`), `fail()`
(`:55`), the `js` value (`:208`), site values. Indentation is for humans; the model pays for the whitespace on every
result. **Recommendation:** serialize model-facing text as **compact** JSON (no indent). Keep indent only for the
human-facing resources (`opencli://…`). Cheap, global, safe.

## 3. Typed tools double-send the payload: `content` text + `structuredContent` (same object)
`ok()` sets both (`server.ts:50-51`); `fail()` too (`:55`). The `js` tool sends **text only** (`:203-212`) — so the
surface is already inconsistent. We removed output schemas in the over-engineering pass, so `structuredContent` is no
longer advertised/validated; a model client reads `content`. Sending both risks 2× tokens if the client forwards
structuredContent into the model context. **Recommendation:** pick one model channel. Either drop `structuredContent`
from results (rely on `content`, matching the `js` tool), or keep `structuredContent` and make `content` a short
pointer. Simplest + consistent: drop `structuredContent`, keep compact `content`.

## 4. Success has no consistent shape, and `ok:true/false` duplicates the protocol's `isError`
- typed tools → bare object (`{tab,url,title,state,…}`)
- site commands → `{ ok:true, site, name, value|rows, columns?, elapsedMs }` (`executor.ts:20-27`)
- `js` → the raw value
- errors → `{ ok:false, error:{code,message,hint?,…} }` + `isError:true`
So the model sees four success shapes, and the in-payload `ok` restates `isError` (the model already knows success from
the protocol). **Recommendation:** (a) drop the `ok` field from payloads — branch on `isError` (keep the rich
`error:{code,…}` object, that's the useful part); (b) site results: return the data (`rows`/`value`) directly, drop the
`site`/`name`/`elapsedMs` bookkeeping from model text (the model called it; elapsed is rarely actionable) — keep
`columns` as a header if useful. Uniform "success = the data, failure = {error}" everywhere.

## 5. Error envelope is good; keep it — small tightening only
`{ code, message, hint?, …data }` with lowercase families (now unified) is the right shape; branchable, actionable.
Minor: ensure every thrown error carries a `hint` where an action is possible; `retryable` only where it means
something. No structural change.

## 6. Lower-impact / keep
- `observe`: `{url,title,state,diff?,changed?}` is lean; the "no change since last observe" sentence is fine (terse).
- `js` first call dumps the full api-reference + js-tool doc (~7 KB) once — a real one-time cost but it is discovery;
  keep (could trim the reference later).
- images already split into their own content block (correct).

## Suggested order (all are safe, gate-verifiable; no real-Chrome needed)
1. Lean `tab_act` result (#1) — biggest win.
2. Compact model-facing JSON (#2).
3. One model channel: drop `structuredContent`, keep compact `content` (#3), unify with `js`.
4. Uniform success/`isError`, lean site results (#4).
5. Error hints tightening (#5) — as encountered.
