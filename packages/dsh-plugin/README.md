# dsh-plugin-opencli-mcp

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that connects the opencli-mcp browser service through dsh's built-in `@deepseek-ai/dsh-mcp-client`. It adds no browser runtime of its own.

## Install

Install the [Chrome extension](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg), then run:

```sh
npm install -g opencli-mcp
opencli-mcp setup --clients none
dsh plugin --profile web add dsh-plugin-opencli-mcp
```

Restart `dsh web`. The bundle starts `opencli-mcp stdio`; dsh discovers its browser tools as `mcp__opencli-mcp__...`. Keep Chrome open and run `opencli-mcp doctor` if the tools do not appear.

The `opencli-mcp` executable must be on the `PATH` used to start dsh. For a desktop launch with a different `PATH`, set `OPENCLI_MCP_BIN` to its absolute path before starting dsh. The bundle uses the current dsh working directory for the MCP child process.

To remove the bundle, run `dsh plugin --profile web remove dsh-plugin-opencli-mcp`. Change `web` to your active dsh profile when needed.
