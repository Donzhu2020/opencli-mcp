## Troubleshooting the browser bridge

- `browser_unavailable`: no extension connected. Run `doctor`. Chrome must be running with the opencli-mcp extension enabled; the runtime is spawned by Chrome through Native Messaging (`opencli-mcp install` writes the host manifest).
- Empty tab lists after finalize are normal. A missing/stale tab does not mean the browser disconnected: open or claim a fresh tab.
- `OPENCLI_CDP_ENDPOINT` lets the runtime drive a CDP-reachable browser (Electron apps, remote Chrome) without the extension.
