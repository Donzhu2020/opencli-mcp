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

## Implemented (2026-09-19, owner: "再深度思考一轮，应该该做的都做")
Deeper pass over the real corpus (`cli-manifest.json`, 1332 commands) refined the strip-list from semantics, not names:
- **#1 done — arg-projection filter (one seam).** `CLI_ONLY_ARGS = {output, output-file, resume-file, all, timeout}` + `projectArgs()` in `src/sites/schema.ts`; applied at all three agent-facing projection points: `argsToShape` (dynamic `<site>_<cmd>` tool schemas), `registry.search` signatures (the `site_run` discovery path), and the `opencli://sites/{site}` resource. None of the five is ever `required`, all are default-safe, so the executor (`coerceArgs`) still supplies their defaults and the js escape hatch can still pass them — projection *hides*, it does not delete behaviour. Also dropped the schema-wide injected `timeout` param on every site tool.
- **#2 partial** — stripping `all` is the concrete MCP-native win (bounded page instead of fetch-everything-to-disk); `limit`/`page`/`cursor`/`offset` stay as the agent's paging inputs. Synthesising a real `nextCursor` across ~1200 adapters is per-adapter work, deferred.
- **#3 partial** — dropped the `→ columns:` suffix from every tool description and `columns` from the site resource (terminal artifact, repeated per tool); kept `columns` in the actual result rows where it can be load-bearing for array rows.
- **#4 checked** — `tab.screenshot()` already returns bytes (no `path` option), so it is already native. Download commands returning host paths would need per-adapter return-as-bytes/resource work; deferred (dev phase). Stripping `output` already stops agents from picking host paths.
- **#5 non-issue** — positional order never surfaces to the agent (search signatures + `coerceArgs` are name-based); nothing to do.
- **Reversed from the first draft after inspecting semantics:** kept `file` (input upload, no MCP alternative), `markdown`/`top-by-engagement`/`no-download` (real data options — `no-download` "only show URL" is the *good* pattern), and `json` (2 cmds, ambiguous data-mode). Judgment per-arg, not by name-matching.

Test: `tests/schema-registry.test.ts` locks the projection (CLI-only stripped from `argsToShape`/`projectArgs`, data+upload args kept, executor still coerces). Gate green (45 tests).
