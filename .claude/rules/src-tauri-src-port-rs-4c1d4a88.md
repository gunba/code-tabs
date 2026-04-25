---
paths:
  - "src-tauri/src/port.rs"
---

# src-tauri/src/port.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Port (skill/memory/MCP) backend

- [PC-01 L136] port_skill / port_memory / port_mcp are Tauri commands in src-tauri/src/port.rs for .claude/ <-> .codex/ portability. Each accepts a direction (claude_to_codex or codex_to_claude), project_dir, and item-specific fields. Every Apply writes a mandatory tarball backup at ~/.claude_tabs/backups/port-<ts>.tar.gz before touching the filesystem. Refusal to write the tarball aborts the port. Deferred: hooks, slash-command-to-skill conversion, .claude/commands/*.md ports.
