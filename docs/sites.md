## Sites as capabilities

The runtime carries OpenCLI's adapter corpus (160+ sites, ~1200 commands: Bilibili, Zhihu, Xiaohongshu, Twitter/X, Reddit, HackerNews, LinkedIn, YouTube, Amazon, GitHub, Notion, ChatGPT/Gemini/Claude web…; Electron desktop-app adapters are excluded because this runtime drives Chrome only). They are not all loaded as tools.

- `sites_search` — find sites/commands by keyword or domain.
- `sites_enable` — load a site's commands as typed tools `<site>_<command>` (read-only by default; `write:true` adds write commands). Emits tools/list_changed. `sites_disable` removes them.
- Every site command is also callable from `js` as `await sites.<site>.<command>({...args})` after enabling.
- Strategies: `public` needs no browser; `cookie`/`intercept`/`ui` reuse your logged-in Chrome session in a background adapter tab; `local` talks to a local service.
- Results carry `columns` + `rows` when tabular. Errors carry stable codes (`AUTH_REQUIRED`, `EMPTY_RESULT`, `TIMEOUT`, `LOGIN_WALL`…).
- `tools_define` registers a new command (JS function or pipeline) that persists across restarts; `tools_compile` drafts one from the current session's recorded steps.
