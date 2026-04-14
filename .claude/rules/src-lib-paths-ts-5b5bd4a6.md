---
paths:
  - "src/lib/paths.ts"
---

# src/lib/paths.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Implementation

- [CI-02 L165] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.

## Activity Panel

- [AP-01 L32] canonicalizePath() in paths.ts converts any path to a stable forward-slash form for identity comparisons: backslashes -> forward slashes, MSYS-style /c/Users/ -> C:/Users/, drive letter normalized to uppercase, trailing slashes stripped. Used at ingress in useTapEventProcessor (ToolInput file_path, InstructionsLoadedEvent, PermissionRejected) and useFileWatcher (fs-change events) to ensure cross-platform path identity.

## Config Schema and Providers

- [CM-02 L164] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.

## Platform

- [PL-02 L15] IS_LINUX export in src/lib/paths.ts mirrors the IS_WINDOWS detection pattern: checks process.platform === 'linux' (Node/vitest) OR navigator.platform.startsWith('Linux') (Tauri WebView). Both IS_LINUX and IS_WINDOWS are exported from paths.ts and imported wherever platform-specific behavior is needed (App.tsx for titlebar/decorations, useTerminal.ts for paste blocker).

## Data Flow

- [DF-09 L121,138] groupSessionsByDir() and swapWithinGroup() in paths.ts: pure functions for tab grouping by normalized workingDir (Map-based, O(n) single pass, insertion-order groups) and position swapping within group boundaries. TabGroup type exported. parseWorktreePath() detects `.claude/worktrees/<slug>` paths, worktreeAcronym() abbreviates slugs by hyphen initials.
