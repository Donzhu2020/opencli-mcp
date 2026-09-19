# Where we're still CLI-shaped, not MCP-native (owner: "原来是 CLI，现在是 MCP，深入分析设计细节")

We rebuilt the runtime MCP-native, but the **site-command corpus is OpenCLI's** — designed for a human at a terminal. The
CLI assumptions leak through the projection layer to the agent. First-principles test for each detail: *does this serve an
agent asking for data over a protocol, or a person typing at a shell and reading a terminal?* Ranked by impact.

## 1. CLI-only args leak straight into MCP tool schemas (the biggest, and central to fix)
`argsToShape` (`src/sites/schema.ts:17`) maps **every** corpus `Arg` into the tool's `inputSchema` verbatim. So the
dynamic `<site>_<command>` tools and `site_run` expose CLI-batch/file args to the agent:
- **`output-file`** (write results as JSONL to a path), **`resume-file`** (batch-resume state), **`all`** (fetch every
  page to disk). For an MCP agent — especially a **remote/cloud** one — a path on the *host's* filesystem is meaningless
  and unreadable; "write all pages to a file" is a shell-batch idea, not "return me the data." The agent sees params it
  cannot use correctly (the twitter.bookmarks report guessed around exactly these).
- **`format` / `json`** (~17 cmds): pick a terminal output format. MCP results are always structured — format is dead.
- **`timeout`** (~68 cmds): a per-command wall-clock knob. MCP has progress + cancellation (which we now forward) and the
  client's own timeout; a `timeout` arg is a CLI holdover.
**MCP-native fix (one place, no per-adapter edits):** a projection layer that, when turning a `CliCommand` into an MCP
tool, **drops CLI-only args** (`output-file`, `resume-file`, `all`, `format`/`json`, and treats `timeout` as
runtime-managed) so the agent never sees them, and the executor ignores/handles them internally. Keep data args (`limit`,
`query`, `cursor`, real inputs). This is in our code (`argsToShape` + `syncSiteTools` + `site_run`), not the 1387 adapters.

## 2. Output model: "write a file / fetch all pages" vs "return data + cursor" 
The corpus's large-result pattern is `--all` + `--output-file` + `--resume-file` — stream everything to local disk and
resume a long job. That is batch-CLI. The MCP-native shape for "a lot of results" is **a bounded page + a `cursor`**, and
the agent loops (`read(cursor)` → `nextCursor`), exactly as `tab.network.read({afterSequence})` already does. Adapters
that page (`page`: ~48 cmds, `cursor`: ~15) should surface a cursor to the agent, not a `--all`-to-file switch. For the
common case the agent wants `limit` (567 cmds already have it — that part is fine) plus, when truncated, a cursor to
continue. **Principle:** results come back over the wire, bounded and continuable; the runtime never writes the user's
disk on the agent's behalf unless the agent explicitly asked for a download it can retrieve.

## 3. Tabular thinking: `columns` / table rendering
Commands carry `columns` for CLI table layout, and the runtime tags rows with them. An agent reads structured JSON;
`columns` is a display concept with no agent value beyond field ordering. Not harmful, but it's a terminal artifact —
either drop it from the agent-facing result or keep it only as optional metadata, not a first-class shape.

## 4. Downloads / files returned as host paths
Anything that returns a **local file path** (downloads, output-file, saved screenshots via `path`) is CLI-native and
breaks for a remote agent. MCP-native: return the bytes (base64/content block) or an MCP **resource** URI the client can
fetch — never a bare host path. (`tab.download`, the screenshot `path` option, adapter output-file all fall here.)

## 5. Positional args
Some corpus args are positional (CLI ordering). MCP tools are named-only; `coerceArgs` bridges it, but positional
semantics are a CLI trace. Low impact — the projection already gives named params; just don't document positions.

## Already MCP-native (don't touch — the rebuild got these right)
The core loop (observe/act/expect/finalize), the one result envelope + coded errors, MRTR confirmations, cursor
pagination in `tab.network.read`, docs-as-interface (`instructions` + on-demand docs), subscriptions/list-changed,
`recon.discover`, and `tools_compile` freezing API-first. These are agent-first by construction.

## Recommendation (independent view)
Do **#1 first** — the arg-projection filter — because it's the highest agent-visible win, lives entirely in our code
(one seam), and needs no corpus edits: strip `output-file`/`resume-file`/`all`/`format` (and drop the `timeout` arg in
favor of runtime timeouts) from the MCP tool schema, and have the executor ignore them. Then **#2** as the standing
principle for paged commands (surface a cursor, don't write files). #3/#4/#5 are cleanup that rides along. This keeps the
CLI corpus intact (we still run it) while making the surface the agent sees genuinely MCP-native.
