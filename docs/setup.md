# Installation and configuration

For the recommended npm + Chrome Web Store installation, follow the [README quick start](../README.md#quick-start).

## What setup does

`npm install -g opencli-mcp` installs the software. `opencli-mcp setup` configures the two connections it needs:

1. **Chrome → local program:** writes the Native Messaging registration so Chrome can start the program when the extension connects.
2. **MCP client → local program:** asks you to select `claude`, `codex`, `opencode`, `pi`, or a combination when their CLIs are on your PATH. Only selected clients are configured, and existing registrations are kept. Pi requires `pi-mcp-adapter`. Choose `manual` (the default) for a ready-to-copy configuration using absolute paths, or `none` to configure only the browser connection.

It then checks the live browser connection. If disconnected, it opens the Chrome Web Store and waits for the extension to connect. The extension retries automatically, so you can install it before or after running setup. Already connected? No store page is opened.

`setup` never installs an extension silently. Add it through the Chrome Web Store. It also does not overwrite existing MCP client settings. If an existing entry points at an old location, replace that entry with the configuration printed by setup.

### Setup options

In a terminal, enter client IDs separated by commas at the prompt. Press Enter to show manual configuration without modifying any client.

For scripts, select clients explicitly. Without `--clients`, non-interactive setup prints manual configuration and leaves all MCP client settings unchanged:

```bash
opencli-mcp setup --clients codex
opencli-mcp setup --clients claude,codex
opencli-mcp setup --clients opencode
opencli-mcp setup --clients pi
opencli-mcp setup --clients manual  # show configuration for any MCP client
opencli-mcp setup --clients none    # configure only the browser connection
opencli-mcp setup --no-open       # print the store link without opening it
opencli-mcp setup --wait 60       # wait up to 60 seconds (default: 180)
opencli-mcp setup --no-open --wait 0  # configure and check once without waiting
```

A timeout leaves the configuration in place: enable the extension and rerun setup. A detected client registration failure is reported as incomplete even if the browser is connected. If a selected CLI is unavailable, setup reports it before writing any configuration. In an interactive terminal, invalid input can be corrected and Ctrl+C cancels without making changes.

`opencli-mcp doctor` checks registration and the live connection without changing settings. It is for troubleshooting; it is not a required setup step.

## Embedding the browser host in an app

Chrome starts a Native Messaging host from one executable path in its manifest. It does not pass arguments or a custom environment. `registerHost()` owns the manifest and the launcher. Call it when the app starts or updates, so the manifest follows the current app location:

```js
import { registerHost } from 'opencli-mcp/host-registration.js';

registerHost();
```

For the normal npm installation, the default uses Node. When called from Electron, it uses the app binary with `ELECTRON_RUN_AS_NODE=1` set in the *new* process. If the app disables Electron's `runAsNode` fuse or ships a dedicated signed helper, provide its executable path:

```js
registerHost({ launch: { kind: 'executable', path: '/absolute/path/to/signed-helper' } });
```

The helper must implement the Native Messaging protocol on stdin/stdout and run the opencli-mcp `host` entrypoint. For another host runtime, pass `{ kind: 'command', command: '/absolute/path/to/runtime', args: ['/absolute/path/to/main.js', 'host'], env: { KEY: 'value' } }`. The library serializes that command into a launcher and writes the manifest for the selected browsers and profiles. An executable path must exist and be absolute.

## OpenCode

Run `opencli-mcp setup --clients opencode`. Setup adds a local MCP server to your global OpenCode config (`~/.config/opencode/opencode.json`, or `opencode.jsonc` if that is your existing file). It preserves comments, other settings, and any existing `opencli-mcp` entry. Restart OpenCode, then use `opencode mcp list` to check the connection. The executable and script paths are absolute, so OpenCode does not need your terminal's npm `PATH`.

## DeepSeek Harness (dsh)

After installing the Chrome extension and `opencli-mcp` globally, connect the browser without configuring another MCP client, then add the dsh bundle to your active profile:

```bash
opencli-mcp setup --clients none
dsh plugin --profile web add opencli-mcp
```

Restart `dsh web`. The main package's bundle inserts one `@deepseek-ai/dsh-mcp-client` entry, so dsh discovers the same MCP tools as other clients. The global `opencli-mcp` executable must be on dsh's `PATH`; set `OPENCLI_MCP_BIN` to its absolute path if dsh is launched from an app with a different `PATH`. To remove the dsh registration, run `dsh plugin --profile web remove opencli-mcp`. Replace `web` with your active dsh profile when needed.

## Pi

Pi does not include an MCP client. Install the community [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), then select Pi in setup:

```bash
pi install npm:pi-mcp-adapter
opencli-mcp setup --clients pi
```

Restart Pi. Setup adds one entry to Pi's own global `mcp.json` (normally `~/.pi/agent/mcp.json`) using absolute paths, without changing other servers. Use the adapter's `mcp` tool to discover and call browser tools.

## Other Chromium browsers

Setup recognizes Chrome, Chromium, Edge, and Brave on macOS and Linux, plus Chrome Beta, Canary, Chrome for Testing, and Arc on macOS. On Windows it registers the Chrome Native Messaging host. Extension availability depends on the browser.

Chrome is registered even before its first launch. Other browsers are detected from their existing profile directories, or can be selected explicitly:

```bash
opencli-mcp setup --browsers edge --no-open
```

Install the extension in that browser. For a browser launched with a custom user data directory:

```bash
opencli-mcp setup --user-data-dir /absolute/path/to/profile
```

Setup also detects running custom profiles on macOS and Linux.

## From source

```bash
git clone https://github.com/jackwener/opencli-mcp.git
cd opencli-mcp
npm install
node dist/src/main.js setup
```

`npm install` runs the build through `prepare`. The same setup flow works with the Web Store extension. For manual MCP client configuration, use the absolute paths printed by setup.

### Developing the extension

Only extension developers need an unpacked build:

1. Run `node dist/src/main.js extension-path` to find the built extension directory.
2. In `chrome://extensions`, enable **Developer mode**, disable the store extension if installed, and **Load unpacked** from that directory.
3. Run `node dist/src/main.js setup --no-open` to configure and verify the connection.

The development manifest uses the published extension's key, so it has the same ID. Use one build at a time. After changing extension code, run `npm run build:ext` and click **Reload** in Chrome.

## From a release tarball

Download a package from [GitHub Releases](https://github.com/jackwener/opencli-mcp/releases), then run:

```bash
npm install -g ./opencli-mcp-<version>.tgz
opencli-mcp setup
```

Use the same Chrome Web Store extension as the npm installation.

## Updating

```bash
npm install -g opencli-mcp@latest
opencli-mcp setup
```

Setup refreshes the browser registration, including the Node.js path. Chrome updates the store extension independently. If the old host is still running, disable and re-enable the extension to start the updated program. If your MCP client uses a path that has changed, replace its entry with the configuration printed by setup, then reconnect it.

## Remote clients

The host serves Streamable HTTP at `http://127.0.0.1:19991/mcp`. Configure the client with:

```text
Authorization: Bearer <contents of ~/.opencli-mcp/token>
X-OpenCLI-Session-ID: <a stable random UUID for this client connection>
```

Each direct HTTP client needs its own `X-OpenCLI-Session-ID`; requests from the same client reuse that value. The stdio launcher creates it automatically. When a direct client is done, send `DELETE /session` with the same two headers to finalize its browser tabs. `session_finalize` also closes or releases tabs at the end of a task.

For access from another machine, use an authenticated tunnel, such as SSH, cloudflared, or ngrok with authentication, and point the client at the tunneled `/mcp` endpoint. Keep bearer authentication enabled and treat the token as a secret. Chrome and the extension must stay running on the host machine.

## Configuration

Settings live in `~/.opencli-mcp/config.json`. For example:

```json
{
  "port": 19991,
  "cursor": true,
  "sites": ["twitter", "reddit"],
  "sitesWrite": []
}
```

| Setting | Effect |
|---|---|
| `port` | Local HTTP port; default `19991` |
| `cursor` | Show the agent cursor overlay |
| `sites` | Site commands to enable at startup, read-only |
| `sitesWrite` | Sites whose write commands should also be enabled |

The same state directory contains the HTTP token, `run/host.json`, and user-defined adapters under `adapters/<site>/<name>.js`.

## Troubleshooting

Run `opencli-mcp doctor` first. It reports whether the browser registration, local host, and extension are connected, with recovery steps for failures. Use `doctor --json` for machine-readable diagnostics.

| Symptom | What to check |
|---|---|
| `browser_unavailable` or host unreachable | Keep Chrome running, enable the extension, and verify the host registration |
| Web Store extension cannot connect | Run `opencli-mcp setup`; if it stays disconnected, disable and re-enable the extension |
| No host manifest was written | Rerun `setup`; for custom profiles, pass `--user-data-dir` |
| MCP client cannot find `opencli-mcp` | Use the absolute executable path in the client configuration |
| Development changes do not appear | Rebuild the extension and click **Reload** on the extensions page |

For runtime errors such as `dialog_open` or stale tabs, see [browser troubleshooting](troubleshooting.md) and [error codes](errors.md).
