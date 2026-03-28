---
paths:
  - "src-tauri/tauri.conf.json"
---

# Window

<!-- Codes: WN=Window -->

- [WN-01] Native Windows decorations with dark theme — no custom HTML titlebar or window control buttons
- [WN-02] App uses `decorations: true` and `"theme": "Dark"` in Tauri window config
- [WN-03] Desktop notifications for background sessions (response complete, permission needed, error). Clicking toast switches to target tab and focuses window. Rate-limited to 1 per session per 30s. Uses custom Rust WinRT toast with on_activated callback instead of Tauri notification plugin (which lacks desktop click support).
  - Files: src/hooks/useNotifications.ts
