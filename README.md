# opencli-mcp

**Let your AI agent use the browser you're already logged into.**

opencli-mcp connects MCP clients to your own Chrome session. Browse websites, run existing site commands, and turn repeated workflows into reusable tools—using your existing logins.

[![npm](https://img.shields.io/npm/v/opencli-mcp)](https://www.npmjs.com/package/opencli-mcp)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install_extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933)](package.json)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[Quick start](#quick-start) · [Usage](#usage) · [Documentation](#documentation) · [中文指南](docs/guide.zh-CN.md)

## What you can do

- **Work with logged-in websites.** Search, read pages, fill forms, and navigate through your existing browser session.
- **Use ready-made site commands.** Discover OpenCLI adapters for sites such as Bilibili, Zhihu, Reddit, Hacker News, and GitHub. Load the commands you need on demand.
- **Build reusable tools.** Explore a workflow, inspect its network requests, and save it as a new MCP tool. Captured JSON APIs are preferred when available.
- **Keep browser work organized.** Agent-created tabs live in named groups and are cleaned up after use. Tabs borrowed from the user are never closed by session cleanup.

Works with MCP clients including Claude Code, Codex, Cursor, and Claude Desktop. Clients can use structured tools for individual actions or a persistent JavaScript session for multi-step workflows.

## Quick start

You need **Node.js 22 or newer**, **Google Chrome**, and an **MCP client**. The local host also supports Chromium-based browsers such as Edge and Brave; see [installation details](docs/setup.md).

### 1. Install the local host

Start Chrome at least once so its profile directory exists, then run:

```bash
npm install -g opencli-mcp
opencli-mcp install
```

`npm install -g` installs the local program. `opencli-mcp install` registers it with Chrome so the extension can start and connect to it. Both the local program and the extension are required.

### 2. Install the Chrome extension

[**Install opencli-mcp from the Chrome Web Store →**](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg)

If you already installed the extension, disable and re-enable it in `chrome://extensions` after registering the host. Keep Chrome running.

### 3. Connect your MCP client

**Claude Code**

```bash
claude mcp add -s user opencli-mcp -- opencli-mcp
```

**Codex**

```bash
codex mcp add opencli-mcp -- opencli-mcp
```

**Cursor / Claude Desktop** — add this entry to your client's MCP configuration:

```json
{
  "mcpServers": {
    "opencli-mcp": {
      "command": "opencli-mcp"
    }
  }
}
```

If your client cannot find the command, use the absolute path to the installed `opencli-mcp` executable. Restart or reconnect your MCP client after configuring it.

### 4. Check the connection

```bash
opencli-mcp doctor
```

Look for `"ok": true` and `"extensionConnected": true`. Then try asking your agent:

> Use opencli-mcp to read the top five Hacker News stories and summarize them with links.

Connection issues? See [troubleshooting](docs/setup.md#troubleshooting).

## Usage

Tell your agent what you want to do; it discovers and calls the MCP tools. For example:

- “Search for opencli-mcp site commands that work with Bilibili.”
- “Open Hacker News, read the newest stories, and keep the most useful page open for me.”
- “Explore this website's search, then create a reusable tool for the same query workflow.”

For integrations and custom workflows, the main tools are:

| Task | Tools |
|---|---|
| Browse a page | `tab_open`, `tab_observe`, `tab_act`, `tab_expect` |
| Use an existing tab | `tab_claim` |
| Finish a browser session | `session_finalize` |
| Discover and run site commands | `sites_search`, `site_run` |
| Create reusable tools | `tools_compile`, `tools_define` |
| Run multi-step JavaScript | `js`, `js_reset` |
| Read built-in documentation | `docs_list`, `docs_get` |

The browser workflow is **observe → act → verify → finalize**. Observations provide accessibility snapshots with element references; actions wait for their targets to be ready before dispatching browser input.

Inside the `js` tool, you can also call site commands directly:

```js
await sites.enable('hackernews');
const stories = await sites.hackernews.top({ limit: 5 });
stories;
```

See the [JavaScript guide](docs/js-tool.md), [API reference](docs/api-reference.md), and [tool authoring guide](docs/define-tools.md) for complete examples.

## How it works

```text
MCP client → opencli-mcp launcher → local host ⇄ Chrome extension → website
                stdio              Native Messaging             your session
```

Chrome starts the local host through Native Messaging. The extension operates browser tabs using Chrome's debugger APIs and Playwright's injected locator engine. The host exposes browser operations, site commands, and tool authoring through MCP.

Without a connected browser, the launcher can still run public site commands in an embedded runtime. Browser operations require Chrome and the extension to be connected.

The host also supports Streamable HTTP for remote clients. See [remote access and configuration](docs/setup.md#remote-clients).

## Browser access and permissions

The extension requests browser permissions including `debugger`, `cookies`, and access to all URLs so it can operate logged-in sites. Connected agents can act with the access available in your browser session.

Site commands are enabled read-only by default; write commands can be enabled explicitly. Optional origin and write-confirmation policies are available, but are off by default and do not automatically gate arbitrary browser clicks. See [configuration](docs/setup.md#configuration) and the [confirmation policy](docs/confirmations.md).

## Documentation

| Guide | Contents |
|---|---|
| [Installation and configuration](docs/setup.md) | Source installs, browser profiles, remote clients, settings, troubleshooting |
| [中文指南](docs/guide.zh-CN.md) | Chinese project overview and detailed usage |
| [Site commands](docs/sites.md) | Discovering, enabling, and running adapters |
| [JavaScript guide](docs/js-tool.md) | Persistent sessions and the object API |
| [API reference](docs/api-reference.md) | Generated reference for browser and tool APIs |
| [Creating tools](docs/define-tools.md) | Compile workflows and define reusable commands |
| [Tab lifecycle](docs/tab-lifecycle.md) | Claiming tabs, grouping, and cleanup |
| [Errors](docs/errors.md) | Error codes and recovery |

## Development

```bash
git clone https://github.com/jackwener/opencli-mcp.git
cd opencli-mcp
npm install
npm run check
```

`npm install` builds the project through its `prepare` script. To connect a development build to Chrome, follow [the unpacked-extension instructions](docs/setup.md#from-source).

```bash
npm run build:ext        # rebuild the extension
npm test                 # unit tests
npm run smoke            # stdio MCP end-to-end check
npm run smoke:browser    # end-to-end check with a connected Chrome extension
```

Before submitting a change, run `npm run check` (typecheck, build, and tests). For browser changes, also run the browser smoke test. `docs/api-reference.md` is generated during the build; update its TypeScript source rather than editing the generated file.

Found a bug or have a feature request? [Open an issue](https://github.com/jackwener/opencli-mcp/issues). See [CHANGELOG.md](CHANGELOG.md) for release history.

## License and credits

[Apache-2.0](LICENSE). Built on [OpenCLI](https://github.com/jackwener/OpenCLI) site adapters and [Playwright](https://github.com/microsoft/playwright)'s injected locator engine. Endpoint analysis is inspired by [jsluice](https://github.com/BishopFox/jsluice).
