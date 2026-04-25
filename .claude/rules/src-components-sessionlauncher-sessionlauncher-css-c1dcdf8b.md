---
paths:
  - "src/components/SessionLauncher/SessionLauncher.css"
---

# src/components/SessionLauncher/SessionLauncher.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-22 L152] .launcher-cli-choice (formerly .launcher-cli-pill for the CLI toggle) renamed to avoid collision with .launcher-cli-pill-active used by flag pills. Active state: orange var(--cli-claude) for Claude, teal var(--cli-codex) for Codex. The CLI toggle now lives inside .launcher-pills-row alongside model and effort dropdowns. config.model and config.effort reset to null when switching CLI if the new adapter does not offer the current selection.
