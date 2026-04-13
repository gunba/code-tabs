---
paths:
  - "src-tauri/src/commands/session.rs"
---

# src-tauri/src/commands/session.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Command Modules

- [RC-01 L7] create_session / close_session -- Session CRUD. close_session does not persist; frontend owns persistence via persist_sessions_json.
- [RC-08 L43] persist_sessions_json / load_persisted_sessions -- Save/restore sessions. persist_sessions_json accepts frontend JSON directly (Rust-side metadata is stale).
