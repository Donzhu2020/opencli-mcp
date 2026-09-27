## JavaScript session semantics

Each MCP client session owns one persistent Node REPL worker. It retains top-level `let`, `const`, `var`, function and class declarations and supports top-level `await`. Calls in the same session run sequentially; use `Promise.all` inside a call for independent work across tabs. Operations on a single tab remain serialized by the browser runtime.

Declarations follow Node REPL semantics. Repeating a top-level `let`/`const` declaration is an error; assign to an existing `let`, choose another name, or reset. Node's native top-level-await evaluator can make a `const` declared in a snippet containing top-level await reassignable. Use `let` for working bindings; do not rely on that Node REPL const edge case. Function declarations and classes persist normally. Ordinary exceptions preserve existing state and output, including any operations already completed.

Every browser/site API method is awaited. The browser object model runs in the host; JavaScript runs in its worker. A Tab handle can be passed to `recon.discover(tab)` or `browser.tabs.finalize({keep:[{tab,status:'deliverable'}]})`. Adapter functions passed to `tools.define` are saved as source, not closures: include dependencies in the function and use its explicit `{tab,args,sites,recon}` inputs. A trial executes outside this REPL.

### Results

The first text block is the result envelope, followed by explicit writes and image blocks. `nodeRepl.write(value)` adds text; `await nodeRepl.emitImage({base64,mimeType})` adds an image. Returned screenshot values, including an image inside `tab.observe({mode:'both'})`, become image blocks. Observation methods return data and do not print automatically.

`js.maxChars` bounds the returned text (default 12000). A truncated result reports `truncated`, `chars`, `limit` and `preview`; it is not a complete dataset. Retain large data in a variable, then filter, aggregate or slice it in subsequent calls. Explicit writes are also bounded. Browser/Tab handles display identity only, never their internal runtime.

### Execution and recovery

Await all API work. If a snippet returns with API work in flight, it fails with `command_outcome_unknown` and clears bindings; that work may still complete. Always await API calls, including calls inside loops. A timeout terminates the JavaScript worker and clears bindings. `js_timeout` means no API call was still in flight; it does not undo earlier actions. `command_outcome_unknown` means an API operation was in flight and may still complete.

MCP cancellation also stops the worker (`js_cancelled`, or `command_outcome_unknown` while an API operation is in flight). `js_reset` also terminates the worker and clears bindings while leaving tabs open. Its `pendingCalls` count reports host operations that were already dispatched. Until they settle, new `js` calls fail with `js_busy`; `doctor` reports `javascript.state` and `javascript.pendingCalls`. Inspect the current page before retrying an uncertain action. Reset/timeout invalidates calls queued before it; those calls do not silently run in a new session.

A host restart or MCP session ending discards REPL bindings. After reconnecting, list the session tabs or claim a tab and obtain a fresh handle. Finalize browser work explicitly with `session_finalize`; resetting JavaScript is not browser cleanup.
