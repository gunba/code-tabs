---
paths:
  - "src-tauri/src/cli_adapter/claude.rs"
---

# src-tauri/src/cli_adapter/claude.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust System Command Modules

- [RC-20 L51] resolve_api_host: hardcoded DNS resolution of api.anthropic.com via spawn_blocking + ToSocketAddrs. 5s tokio::time::timeout. Returns Cloudflare edge IP string. No parameters (least privilege). Registered in generate_handler. source: src-tauri/src/commands/config.rs:L605,L609
