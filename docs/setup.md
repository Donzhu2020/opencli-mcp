# Installation and configuration

For the recommended npm + Chrome Web Store installation, follow the [README quick start](../README.md#quick-start).

## Other Chromium browsers

The installer recognizes Chrome, Chromium, Edge, and Brave on macOS and Linux, plus Chrome Beta, Canary, Chrome for Testing, and Arc on macOS. On Windows it registers the Chrome Native Messaging host. Extension availability and installation steps depend on the browser.

Start your browser at least once before installing the host. To target a specific supported browser, use, for example:

```bash
opencli-mcp install --browsers edge --extension-id lnaoghmfcdnbhgcihkakfobckmfhllkg
```

For a browser launched with a custom user data directory:

```bash
opencli-mcp install --user-data-dir /absolute/path/to/profile --extension-id lnaoghmfcdnbhgcihkakfobckmfhllkg
```

The installer also detects running custom profiles on macOS and Linux.

## From source

```bash
git clone https://github.com/jackwener/opencli-mcp.git
cd opencli-mcp
npm install
node dist/src/main.js setup
```

`npm install` runs the build through `prepare`. `setup` registers the development Native Messaging host, registers Claude Code and Codex when their CLIs are available, and opens the extensions page with the unpacked-extension path copied to your clipboard.

In Chrome, enable **Developer mode**, choose **Load unpacked**, and select that directory. `setup` waits for the extension to connect. Use `setup --no-open` to skip opening the extensions page, or `setup --wait 60` to change the wait time in seconds.

For other MCP clients, use the configuration printed by `setup`, or configure `node` with the absolute path to `dist/src/main.js` as its argument. Optionally run `npm link` to make `opencli-mcp` available on your PATH.

After changing extension code, run `npm run build:ext` and click **Reload** in `chrome://extensions`.

### Extension IDs

The Chrome Web Store extension ID is **`lnaoghmfcdnbhgcihkakfobckmfhllkg`**. The current source manifest and npm 0.0.10 use the same key-derived ID; older builds used a different key.

`install --extension-id lnaoghmfcdnbhgcihkakfobckmfhllkg` explicitly adds the store ID alongside the bundled extension ID. This avoids depending on which development key your installed package contains. The current `setup` command still prompts you to load an unpacked extension, so use the README workflow for store installations.

## From a release tarball

Download a package from [GitHub Releases](https://github.com/jackwener/opencli-mcp/releases), then install it:

```bash
npm install -g ./opencli-mcp-<version>.tgz
opencli-mcp install --extension-id lnaoghmfcdnbhgcihkakfobckmfhllkg
```

Continue with the Web Store extension and client configuration in the [quick start](../README.md#quick-start). For an unpacked extension from a release zip, use the development workflow above instead.

## Remote clients

The host serves Streamable HTTP at `http://127.0.0.1:19991/mcp`. Configure the client with:

```text
Authorization: Bearer <contents of ~/.opencli-mcp/token>
```

For access from another machine, use an authenticated tunnel, such as SSH, cloudflared, or ngrok with authentication, and point the client at the tunneled `/mcp` endpoint. Keep bearer authentication enabled and treat the token as a secret. Chrome and the extension must stay running on the host machine.

## Configuration

Settings live in `~/.opencli-mcp/config.json`. For example:

```json
{
  "port": 19991,
  "cursor": true,
  "sites": ["hackernews", "reddit"],
  "sitesWrite": [],
  "policy": {
    "askNewOrigins": false,
    "confirmWrites": false,
    "allowedHosts": []
  }
}
```

| Setting | Effect |
|---|---|
| `port` | Local HTTP port; default `19991` |
| `cursor` | Show the agent cursor overlay |
| `sites` | Site commands to enable at startup, read-only |
| `sitesWrite` | Sites whose write commands should also be enabled |
| `policy.askNewOrigins` | Require `session.allowOrigin(host)` before navigating to a new host |
| `policy.confirmWrites` | Request client approval for write site commands; does not automatically gate arbitrary UI actions |
| `policy.allowedHosts` | Hosts pre-approved for the origin policy |

The same state directory contains the HTTP token, `run/host.json`, and agent-defined tools under `tools/<site>/<name>.js`. See [confirmations](confirmations.md) for the agent-facing action policy.

## Troubleshooting

Run `opencli-mcp doctor` first. A working connection reports `ok: true` and `host.extensionConnected: true`.

| Symptom | What to check |
|---|---|
| `browser_unavailable` or host unreachable | Keep Chrome running, enable the extension, and verify the host registration |
| Web Store extension cannot connect | Run `opencli-mcp install --extension-id lnaoghmfcdnbhgcihkakfobckmfhllkg`, then disable and re-enable the extension |
| No host manifest was written | Start the browser once, then repeat the install command; for custom profiles, pass `--user-data-dir` |
| MCP client cannot find `opencli-mcp` | Use the absolute executable path in the client configuration |
| Development changes do not appear | Rebuild the extension and click **Reload** on the extensions page |

The current `doctor` output shows the bundled extension ID and may suggest loading an unpacked extension. For a Web Store installation, use the store registration command above and check the connection fields instead.

For runtime errors such as `dialog_open` or stale tabs, see [browser troubleshooting](troubleshooting.md) and [error codes](errors.md).
