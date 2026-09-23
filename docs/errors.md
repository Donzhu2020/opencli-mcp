## Error codes — branch on `error.code`, never on message text

Every error has `code`, `message`, optional `hint`, and any structured data spread beside them (`candidates`, `details`, `dialog`, `expect`, `failed`, `retryable`). Same shape from typed tools, `js`, and site commands.

| family | codes | what to do |
|---|---|---|
| locating | `not_found`, `selector_ambiguous` (+`candidates`), `stale_ref`, `invalid_target`, `missing_target` | observe again for fresh refs; scope with `within`, use the `selector` from find; `stale_ref` after navigation |
| actionability | `not_visible`, `not_enabled`, `not_editable`, `not_checkable`, `not_a_select`, `not_a_file_input`, `intercepted` (blocker named), `not_delivered`, `option_not_found` (+`available`), `timeout` | the element exists but cannot take the action; dismiss the blocker, target the real control, or wait with `expect`. `not_delivered`: the mouse event never reached the page. Retry that same target once with `method:"dom"` (HTMLElement.click(), no mouse event) only in that case, or when `not_visible` says the element has no box. A click that already returned ok must not be repeated with `method:"dom"` |
| navigation | `invalid_url`, `page_not_loaded`, `stale_page`, `page_not_in_session`, `page_released`, `tab_create_failed`, `no_tab` | the URL was blocked/unreachable, the tab is gone, or finalize handed it back to the user; open or claim a fresh tab |
| frames | `frame_not_found` (which level is named), `frame_unreachable` | check the chain outermost-first; the frame may still be loading |
| dialogs | `dialog_open` (+`dialog`), `no_dialog`, `dialog_answer_timeout` | read with `tab.dialog.get()`, answer with accept/dismiss, then retry |
| expectations & frozen tools | `expectation_failed` (+`expect`, `failed`, `state`), `step_failed`, `invalid_definition`, `unknown_site`, `unknown_command`, `adapter_load` | fix the one step named in `details.step`/`label`; check the definition |
| claiming tabs | `claim_not_found`, `claim_ambiguous` (+candidates), `claim_identity_mismatch`, `claim_not_allowed`, `already_claimed` | list `browser.user.openTabs()` and claim by `tabId` |
| runtime | `browser_unavailable`, `unsupported_backend`, `unknown_browser`, `unknown_capability`, `unknown_doc`, `evaluate_read_only`, `cancelled`, `command_lost`, `command_failed`, `result_evicted` | run `doctor`; use `tab.act` for writes; retry after reconnect |
