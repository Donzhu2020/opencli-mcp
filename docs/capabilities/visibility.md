## Capability: visibility
`(await browser.capabilities.get('visibility')).set(visible)` brings the session's window to the foreground (or sends it back). Keep work in the background unless the user asked to watch. The cursor overlay animates only on visible tabs.
