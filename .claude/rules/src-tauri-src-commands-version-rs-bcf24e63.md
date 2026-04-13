---
paths:
  - "src-tauri/src/commands/version.rs"
---

# src-tauri/src/commands/version.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Version & Auto-Update

- [VA-03 L1] Rust version commands: get_build_info returns CARGO_PKG_VERSION + CLAUDE_CODE_BUILD_VERSION (embedded at compile time via build.rs cargo:rustc-env). check_latest_cli_version queries npm dist-tags endpoint (10s timeout). update_cli detects install method from CLI path (brew/npm/volta/binary) via detect_install_method with Windows backslash normalization, runs the appropriate update command with CREATE_NO_WINDOW on Windows.
