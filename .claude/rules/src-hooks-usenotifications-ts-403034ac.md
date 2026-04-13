---
paths:
  - "src/hooks/useNotifications.ts"
---

# src/hooks/useNotifications.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Window

- [WN-03 L22] Desktop notifications for background sessions (response complete, permission needed, error). Clicking toast switches to target tab and focuses window. Rate-limited to 1 per session per 30s. Uses custom Rust WinRT toast with on_activated callback instead of Tauri notification plugin (which lacks desktop click support).
- [WN-04 L107] When a background-session notification fires while the main window is unfocused, `useNotifications` flashes the OS taskbar/user-attention indicator via `requestUserAttention(UserAttentionType.Informational)`. This path depends on `core:window:allow-request-user-attention` in `src-tauri/capabilities/default.json`.

## Development Rules

- [DR-08 L108] Use `dlog(module, sessionId, message, level?)` from `src/lib/debugLog.ts` for all application logging. Never use raw `console.log/warn/error`. Module names: `pty`, `inspector`, `terminal`, `session`, `config`, `launcher`, `resume`, `tap`, `proxy`, `notify`. Pass `sessionId` when in scope, `null` otherwise. Use `"DEBUG"` level for verbose tracing, `"WARN"`/`"ERR"` for problems.
