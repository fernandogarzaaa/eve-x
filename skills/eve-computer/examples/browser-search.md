# Example: browser search

Goal: "open Firefox and search for EVE-X".

1. `eve_session_create({ goal })` → `sess-abc123`.
2. `eve_computer_observe(sess-abc123)` → taskbar region `r-taskbar` @ 0.99.
3. `eve_computer_act(sess, { type: "open_application", text: "firefox", confidence: 0.9 })`.
4. Re-observe: address bar region appears; `type` the query with confidence 0.85.
5. Verify results page; `eve_report(sess)` for the summary.
