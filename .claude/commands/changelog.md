---
description: "Scan Claude Code changelog for changes relevant to this repo"
---

Scan the Claude Code upstream changelog for changes that affect this project. Only analyze versions newer than the last check.

## 1. Determine version range

Read `.claude/changelog-last-version`. If missing, treat last-checked as `2.1.79`.

## 2. Fetch changelog

Fetch the raw changelog:

```
WebFetch https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
```

Extract only entries **after** the last-checked version, up to and including the latest version listed.

If there are no new versions since last check, report "No new changes since {version}" and stop.

## 3. Scan the codebase for conflict surfaces

Search the codebase (grep/glob) to build a current inventory of:

- **Keybindings**: all `Ctrl+`, `Alt+`, `Meta+` combinations registered in `src/App.tsx`, `src/hooks/useTerminal.ts`, `src/components/` (keydown handlers, `attachCustomKeyEventHandler`)
- **IPC commands**: all `invoke()` calls and Tauri command names in `src-tauri/src/commands.rs`
- **Inspector protocol**: BUN_INSPECT usage in `src/hooks/useInspectorState.ts`, `src/lib/inspectorHooks.ts`
- **CLI flags/args**: flags passed to `claude` in `src/lib/claude.ts`, `src/lib/ptyProcess.ts`
- **Settings schema**: fields read from CLI settings in `src/lib/settingsSchema.ts`

## 4. Analyze each new changelog entry

For every bullet point in the new versions, classify relevance:

### CONFLICT (action required)
Changes that **break or interfere** with something we already do:
- Keybinding clashes (Claude Code added a binding we already use)
- Removed/renamed CLI flags we pass
- Changed output format we parse
- Settings schema changes that break our reader
- Inspector/debug protocol changes

### OPPORTUNITY (worth considering)
New features we could **leverage or integrate**:
- New CLI flags that improve our PTY sessions
- New inspector capabilities we could use for state detection
- New settings/config we should expose in ConfigManager
- Performance improvements that change our assumptions
- New APIs or hooks

### INFORMATIONAL (note for awareness)
Changes that don't directly affect us but are good to know:
- Bug fixes in areas we interact with
- Platform-specific fixes (Windows, Linux)
- Security changes

Skip entries that are purely internal to Claude Code's own UI (VS Code extension, web interface, etc.) with no bearing on the CLI.

## 5. Report

```
## Changelog scan: {from_version} -> {to_version}

### CONFLICTS
[each with: what changed, what it conflicts with in our code (file:line), suggested fix]

### OPPORTUNITIES
[each with: what's new, how we could use it, rough scope]

### INFORMATIONAL
[brief list]

### No impact
{count} entries skipped (IDE-only, internal, or irrelevant)
```

If there are CONFLICTS, list them first and emphasize urgency.

## 6. Update version marker

After presenting the report and confirming the user has seen it, write the latest analyzed version to `.claude/changelog-last-version`:

```
{latest_version}
```

Single line, just the version number (e.g. `2.1.83`).
