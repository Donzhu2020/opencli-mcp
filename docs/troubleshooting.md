## Troubleshooting the browser bridge

- `browser_unavailable`: no extension connected. Run `doctor`. Chrome must be running with the opencli-mcp extension enabled; the runtime is spawned by Chrome through Native Messaging (`opencli-mcp install` writes the host manifest).
- `dialog_open`: a native JavaScript dialog is blocking the tab. `tab_dialog` reads and answers it. `no_dialog`: nothing is pending (dialogs are tracked only while the debugger is attached, so one opened before the first command may need a `tab_evaluate` to surface).
- Empty tab lists after finalize are normal. A missing/stale tab does not mean the browser disconnected: open or claim a fresh tab.
