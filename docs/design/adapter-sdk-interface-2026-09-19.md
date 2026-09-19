# The adapter interface (first principles, agent-friendly)

Owner: design the interfaces with care. Two interfaces matter, and the key decision unifies them.

## The one decision: the adapter interface = the agent's own object model
A corpus adapter and an agent exploring in the `js` tool are doing the *same thing*: driving a logged-in tab to get
data. So they should use the *same* API. An adapter's `run(ctx)` receives the exact `{ tab, sites, recon }` an agent
uses in `js`. There is no second "page" world (the old CDPBasePage contract with ~10 reimplemented methods is gone).

Consequences:
- An agent that can read/write `js` code can read/write any adapter — zero new vocabulary.
- `tools.define` (agent authors a tool) and a shipped adapter are the *same shape* — the frozen exploration.
- One engine, one contract, tested once.

## Interface 1 — the descriptor (what an adapter file exports)
```js
import { defineAdapter } from '@opencli-mcp/adapter-sdk'

export default defineAdapter({
  description: 'Your bookmarked tweets, newest first',   // one line, agent-facing, no CLI grammar
  access: 'read',                                          // 'read' | 'write' — the only safety-relevant field
  domain: 'x.com',                                         // favicon + default navigation host
  args: [                                                  // snake_case names (agent-native JSON keys)
    { name: 'limit', type: 'int', default: 20, help: 'How many to return' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
  ],
  async run({ tab, args }) {                               // returns rows/object/value; the envelope wraps it
    ...
    return { rows, nextCursor }
  },
})
```
- **No `site`/`name` in the descriptor** — identity is the file path (`adapters/<site>/<command>.js`).
- **No `pipeline`, no `columns`, no `strategy`, no `output/format/timeout`** — one impl form (`run`), objects not
  tables, no CLI knobs. `access` is the whole safety surface; `browser:false` (rare) opts out of needing a page.
- Descriptor is pure data + one function. `defineAdapter` validates and returns it — **no global registration.**

## Interface 2 — the context `run` receives
```ts
interface AdapterContext {
  args: Record<string, unknown>     // validated + defaulted against `args`
  tab: Tab                          // the object model: goto/observe/act/evaluate/fetchJson/cookie/network/…
  sites: Sites                      // call a sibling command: await sites.twitter.search({ q })
  recon: Recon                      // endpoint discovery: await recon.discover(tab)
  signal?: AbortSignal              // MCP cancellation
}
```
`Tab` is a structural interface in the SDK (the subset adapters use); core's concrete `Tab` satisfies it. So the SDK
carries the *contract*, not the implementation — adapters depend only on the SDK.

## Agent-friendly result shape (unchanged, reaffirmed)
`run` returns plain data: an **array of objects** (rows) or a single object/value. For paged sources, return
`{ rows, nextCursor }` — the MCP-native pagination we standardized. No host paths, no files, expanded URLs not t.co.
The server's envelope (`{ok:true, …}`) and projection wrap it; the adapter just returns clean data.

## Why this is the elegant end state
- Descriptor: pure data + `run`. Loader: path → import → `.default`. No manifest, no global registry, no pipeline DSL.
- The contract an adapter depends on is exactly the agent's object model + `defineAdapter` — small, already tested,
  already documented (the `js` api-reference *is* the adapter SDK reference).
