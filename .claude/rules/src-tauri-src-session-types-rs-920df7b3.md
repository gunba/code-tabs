---
paths:
  - "src-tauri/src/session/types.rs"
---

# src-tauri/src/session/types.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Types

- [ST-01 L44] SessionConfig has a launch_working_dir: Option<String> field (#[serde(default)]). It records the directory that was active at session launch time, distinct from working_dir which may be updated by WorktreeState/WorktreeCleared tap events during the session lifetime.

## Codex CLI Adapter

- [CC-04 L48] SessionConfig.cli field (CliKind enum, serde lowercase: 'claude'|'codex', default Claude) records the per-session CLI choice. Added alongside removal of providerId from SessionConfig. Defaults to CliKind::Claude for migrated sessions with no cli field (serde(default)).
