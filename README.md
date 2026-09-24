# opencli-mcp

**A browser service for MCP agents, connected to the Chrome you're already logged into.**

opencli-mcp lets MCP clients observe and operate your Chrome tabs through a local extension and host. Optional site adapters package verified workflows as reusable tools.

[![npm](https://img.shields.io/npm/v/opencli-mcp)](https://www.npmjs.com/package/opencli-mcp)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install_extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933)](package.json)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[Quick start](#quick-start) · [Usage](#usage) · [Documentation](#documentation) · [中文指南](docs/guide.zh-CN.md)

## What you can do

- **Work with logged-in websites.** Search, read pages, fill forms, and navigate through your existing browser session.
- **Use optional site commands.** Discover built-in adapters for Twitter/X, Bilibili, and Reddit when a site-specific command helps.
- **Add site adapters.** Inspect a site's requests, verify an API, and define an explicit reusable MCP tool.
- **Keep browser work organized.** Agent-created tabs live in named groups and are cleaned up after use. Tabs borrowed from the user are never closed by session cleanup.

Works with MCP clients including Claude Code, Codex, OpenCode, Cursor, Claude Desktop, DeepSeek Harness (`dsh`), and Pi (with `pi-mcp-adapter`). Clients can use structured tools for individual actions or a persistent JavaScript session for multi-step workflows.

## Quick start

You need **Node.js 22 or newer**, **Google Chrome**, and an **MCP client**. The local host also supports Chromium-based browsers such as Edge and Brave; see [installation details](docs/setup.md).

### 1. Install the Chrome extension

[**Install opencli-mcp from the Chrome Web Store →**](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg)

For an extension version ahead of the Web Store, download the **manual-install zip** from [GitHub Releases](https://github.com/jackwener/opencli-mcp/releases) and follow the [manual installation steps](docs/setup.md#manual-extension-installation).

### 2. Install the npm package and set up the connection

```bash
npm install -g opencli-mcp
opencli-mcp setup
```

Keep Chrome open. `setup` connects the extension to the local program, asks which MCP clients to configure, registers only your selection, and checks the browser connection. If you have not installed the extension yet, it opens the Chrome Web Store for you.

For **Cursor, Claude Desktop, and other MCP clients**, choose `manual` and copy the configuration printed by `setup` into your client's MCP settings. It uses absolute paths so desktop apps can find the program.

For **OpenCode**, run `opencli-mcp setup --clients opencode`. It adds a global MCP entry while preserving your other settings.

For **DeepSeek Harness (`dsh`)**, run `opencli-mcp setup --clients none`, then add the same npm package to your dsh profile:

```bash
dsh plugin --profile web add opencli-mcp
```

Restart `dsh web`. The package's dsh bundle uses dsh's MCP client to connect to the browser service. See the [dsh setup details](docs/setup.md#deepseek-harness-dsh).

For **Pi**, install `pi-mcp-adapter`, then run `opencli-mcp setup --clients pi`. See the [Pi setup steps](docs/setup.md#pi).

### 3. Start using it

Restart or reconnect your MCP client, then ask:

> Use opencli-mcp to read the top five Hacker News stories and summarize them with links.

You can rerun `opencli-mcp setup` to repair the browser registration or select newly installed clients to configure. Existing MCP client settings are preserved. For a read-only connection check, run `opencli-mcp doctor`.

Connection issues? See [troubleshooting](docs/setup.md#troubleshooting).

## Usage

Tell your agent what you want to do; it discovers and calls the MCP tools. For example:

- “Open Hacker News, read the newest stories, and keep the most useful page open for me.”
- “Search for site commands that work with Bilibili.”
- “Explore this website's search, then create a reusable tool for the same query workflow.”

For integrations and custom workflows, the main tools are:

| Task | Tools |
|---|---|
| Browse a page | `tab_open`, `tab_observe`, `tab_read`, `tab_act`, `tab_expect` |
| Find or use an existing tab | `tab_list`, `tab_claim` |
| Wait for a download started by an action | `tab_download_wait` |
| Keep a tab open or close it | `tab_release`, `tab_close` |
| Finish a browser session | `session_finalize` |
| Discover and run site commands | `sites_search`, `site_run` |
| Define and verify a site adapter | `tools_define`, `tools_try`, `tools_activate` |
| Run multi-step JavaScript | `js`, `js_reset` |
| Read built-in documentation | `docs_list`, `docs_get` |

The browser workflow is **observe → act → verify → finalize**. `tab_observe` is the action map (accessibility snapshot with element references); pass its `snapshotId` as `since` for an exact diff. `tab_read` is rendered document text; pass its `readId` and `nextStart` back together to continue the same capture. Actions wait for their targets to be ready before dispatching browser input.

Browser control starts explicitly with `tab_open` or `tab_claim`; `tab_list` shows session tabs and, with `user:true`, up to 20 recent tabs available to claim. Use `query` to find an older tab by title or URL. `tab_release` leaves a tab open and gives up control. `tab_close` closes it, including a claimed user tab. Session cleanup closes agent-created tabs that you do not keep and releases claimed user tabs; any cleanup failures are reported for retry.

Inside the `js` tool, you can also call site commands directly:

```js
await sites.enable('reddit');
const posts = await sites.reddit.hot({ subreddit: 'programming', limit: 5 });
posts;
```

See the [JavaScript guide](docs/js-tool.md), [API reference](docs/api-reference.md), and [tool authoring guide](docs/define-tools.md) for complete examples.

## How it works

```text
MCP client → opencli-mcp launcher → local host ⇄ Chrome extension → website
                stdio              Native Messaging             your session
```

Chrome starts the local host through Native Messaging. The extension operates browser tabs using Chrome's debugger APIs and Playwright's injected locator engine. The host exposes browser operations, site commands, and tool authoring through MCP.
Each MCP client connection has its own tab and JavaScript session, so one client's cleanup does not close another client's tabs.

The MCP launcher can start before Chrome. It keeps the client connection open and reconnects when the Chrome-owned host appears or restarts. Browser operations and site adapters use that host; run `opencli-mcp doctor` if it stays unavailable.

The host also supports Streamable HTTP for remote clients. See [remote access and configuration](docs/setup.md#remote-clients).

## Browser access and permissions

The extension requests browser permissions including `debugger`, `cookies`, and access to all URLs so it can operate logged-in sites. Connected agents can act with the access available in your browser session.

Site commands execute directly without additional approval prompts. The read/write classification describes their effects. See [configuration](docs/setup.md#configuration).

## Documentation

| Guide | Contents |
|---|---|
| [Installation and configuration](docs/setup.md) | Source installs, browser profiles, remote clients, settings, troubleshooting |
| [中文指南](docs/guide.zh-CN.md) | Chinese project overview and detailed usage |
| [Site commands](docs/sites.md) | Discovering, enabling, and running adapters |
| [JavaScript guide](docs/js-tool.md) | Persistent sessions and the object API |
| [API reference](docs/api-reference.md) | Generated reference for browser and tool APIs |
| [Creating tools](docs/define-tools.md) | Define and verify reusable site adapters |
| [Tab lifecycle](docs/tab-lifecycle.md) | Claiming tabs, grouping, and cleanup |
| [Errors](docs/errors.md) | Error codes and recovery |

## Development

```bash
git clone https://github.com/jackwener/opencli-mcp.git
cd opencli-mcp
npm install
npm run typecheck
```

`npm install` builds the project through its `prepare` script. To connect a development build to Chrome, follow [the unpacked-extension instructions](docs/setup.md#from-source).

```bash
npm run build:ext        # rebuild the extension
npm test                 # unit tests
npm run smoke:setup      # isolated setup and Native Messaging end-to-end check
npm run smoke:browser    # end-to-end check with a connected Chrome extension
```

Run the tests relevant to your change. `npm run check` runs typecheck, build, and the full test suite when a broader check is needed. For browser changes, use the browser smoke test. `docs/api-reference.md` is generated during the build; update its TypeScript source rather than editing the generated file.

Maintainers: use the [release workflow](docs/releasing.md) to publish the npm package and GitHub Release.

Found a bug or have a feature request? [Open an issue](https://github.com/jackwener/opencli-mcp/issues). See [CHANGELOG.md](CHANGELOG.md) for release history.

## License and credits

[Apache-2.0](LICENSE). Some browser helpers and adapters were adapted from [OpenCLI](https://github.com/jackwener/OpenCLI); no OpenCLI dependency or compatibility layer is required. Uses [Playwright](https://github.com/microsoft/playwright)'s injected locator engine. Endpoint analysis is inspired by [jsluice](https://github.com/BishopFox/jsluice).
