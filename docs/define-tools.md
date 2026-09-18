## tools_define / tools_compile — freezing a flow

A frozen flow runs on exactly the engine the agent used: `page.act` (same locate → wait → hit-test → real input), `page.expect` (the same checks), `page.aria()` (the same observation). Freezing changes nothing about how the page is driven.

`tools_compile` drafts a definition from this session's recorded steps:
- Network-first: if a JSON endpoint of the site was captured (`tab_network`), the tool becomes one `page.fetchJson` call through the logged-in page.
- Otherwise every recorded step becomes a line: `page.goto`, `page.act({kind, target:{selector}, value})` with the Playwright selector recorded when you acted, and `page.expect({...})` for every `tab_expect` you made. Put a `tab_expect` after each meaningful step while exploring — those checkpoints are what make the frozen tool trustworthy.
- `inputs` are explicit: `{query: "what you typed"}` or `{query: {sample: "what you typed", description: "search terms", type: "string"}}`. Only exact occurrences of the sample become `args.query`; nothing is guessed.
- Each step is wrapped: a failure reports `error.details.step`, `label`, the engine's error code/hint, and the page state at that moment, so the agent (or you) can fix the one step that broke.

`tools_define` takes `{site, name, description, access, strategy?, domain?, args?, columns?, pipeline? | func?}`. `func` is the source of `async (page, args) => {…}`. `page` is the same page object the agent has: `goto, act, expect, aria, evaluate, fetchJson, getCookies, wait, screenshot, network` plus OpenCLI's adapter helpers (`click/fillText/typeText/setChecked` all route to `act`). Review the draft, then `tools_define` it and run it once.
