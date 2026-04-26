---
paths:
  - "src-tauri/src/bin/discover_audit.rs"
---

# src-tauri/src/bin/discover_audit.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Discover Audit Binary

- [DA-01 L3] discover_audit is a standalone Rust binary (src-tauri/src/bin/discover_audit.rs) with three subcommands: 'dump' (print what discovery finds, no network), 'audit' (diff discovered items against cached docs fixtures, exit 1 on missing), 'fetch-docs' (download code.claude.com docs pages into src-tauri/tests/fixtures/). Invoked via npm scripts: discover:dump, discover:audit, discover:fetch-docs. Exit codes: 0=success, 1=missing items, 2=usage error, 3=runtime error.
- [DA-02 L4] Discovery audit CI (.github/workflows/discovery-audit.yml) is advisory-only (continue-on-error: true). Triggers on PRs touching discovery sources, the audit binary, cli.rs, docs fixtures, Cargo.toml, or the workflow itself; plus weekly on Monday 07:17 UTC. Reports missing (documented but not discovered) and extra (discovered but not documented) items as a step summary and PR comment. Fixes for missing items go in src-tauri/src/discovery/mod.rs scanners, not the static fallback catalog.
