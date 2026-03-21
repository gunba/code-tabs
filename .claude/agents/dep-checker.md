---
tools: Read, Glob, Grep, Bash
---

Check for outdated or unused dependencies.

1. Read package.json and src-tauri/Cargo.toml.
2. For JS: run `npm outdated` and report packages with major version bumps.
3. For Rust: run `cargo outdated -R` (if available) or check Cargo.lock for stale entries.
4. Grep the codebase for each dependency to verify it's actually imported/used.
5. Report: used deps with available updates, and deps that appear unused.
