## Sites as capabilities

Built-in adapters cover Twitter/X (`twitter`), Bilibili (`bilibili`), and Reddit (`reddit`). The source directories are the command catalog; use search to discover the current commands and their parameters.

- `sites_search` finds commands by keyword or domain and returns their argument schemas.
- `site_run` executes a command directly without enabling it first.
- `sites.enable(site, {write?})` in `js` exposes typed tools named `<site>_<command>` and emits `tools/list_changed`. By default it exposes read commands; `write:true` also exposes write commands. `sites.disable(site)` removes those tools.
- Commands are also callable in `js` as `await sites.<site>.<command>({...args})`.
- Adapters use the same `tab` object API as interactive exploration and run in a background tab of the connected Chrome profile.
- Results contain `rows` (optionally `nextCursor`) or a `value`. Failures contain `error.code`, `error.message`, and optional `error.hint` / details; inspect the returned error to recover.
- `tools_define` saves an explicit JavaScript function as an adapter under `~/.opencli-mcp/adapters/<site>/<command>.js`. User adapters override built-ins with the same site and command. Verify the function with `site_run` before relying on it.

For authoring, call `docs_get` with `name: "define-tools"`.
