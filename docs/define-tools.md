## tools_define / tools_compile

`tools_define` takes `{site, name, description, access, strategy?, domain?, args?, columns?, pipeline? | func?}`. `func` is the source of `async (page, args) => {…}` (browser strategies) or `async (args) => {…}` (public). The `page` object is OpenCLI's IPage: `goto, evaluate, fetchJson, getCookies, snapshot, click, fillText, typeText, pressKey, wait, networkRequests, screenshot`. The tool is written to `~/.opencli-mcp/tools/<site>/<name>.js`, registered immediately and available as `<site>_<name>` (after `sites_enable <site>`) and as `sites.<site>.<name>()` in `js`.

`tools_compile` drafts a definition from the current session's recorded steps: if a JSON endpoint was captured it becomes a `page.fetchJson` call; otherwise the UI steps become explicit page calls. Pass `inputs` (`{query: "the value you typed"}`) to turn literals into parameters. Review the draft, then `tools_define` it.
