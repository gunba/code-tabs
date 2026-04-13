---
paths:
  - "src/lib/paths.ts"
---

# src/lib/paths.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Implementation

- [CI-02 L160] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.

## Activity Panel

- [AP-01 L27] canonicalizePath() in paths.ts converts any path to a stable forward-slash form for identity comparisons: backslashes -> forward slashes, MSYS-style /c/Users/ -> C:/Users/, drive letter normalized to uppercase, trailing slashes stripped. Used at ingress in useTapEventProcessor (ToolInput file_path, InstructionsLoadedEvent, PermissionRejected) and useFileWatcher (fs-change events) to ensure cross-platform path identity.

## Config Schema and Providers

- [CM-02 L159] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.

## Data Flow

- [DF-09 L116,133] groupSessionsByDir() and swapWithinGroup() in paths.ts: pure functions for tab grouping by normalized workingDir (Map-based, O(n) single pass, insertion-order groups) and position swapping within group boundaries. TabGroup type exported. parseWorktreePath() detects `.claude/worktrees/<slug>` paths, worktreeAcronym() abbreviates slugs by hyphen initials.
