---
paths:
  - "src/store/settings.ts"
---

# src/store/settings.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Notes Panel

- [NP-02 L725] workspaceNotes persist migration: settings store v16 adds workspaceNotes field (backfilled as empty object {} for older persisted states in version<16 migration). workspaceNotes is included in the partialize list so it persists across restarts. source: src/store/settings.ts:L102,L827

## Config Implementation

- [CI-05 L29] Recording defaults: TAP/traffic enabled, debugCapture enabled, stdout/stderr off. Migrations backfill expanded TAP categories (v6) and debugCapture=true (v8).
  - Defaults keep TAP/traffic enabled, force stdout/stderr off, and seed fspromises, bunfile, abort, fswatch, textdecoder, events, and envproxy category toggles.
  - The version < 6 migration forces stdout/stderr=false and only fills the new category keys when they are absent in persisted state.
- [CI-06 L30] RecordingConfig.debugCapture toggle: a boolean field in RecordingConfig (default true) controls whether DEBUG-level entries are captured. Toggled via a checkbox in RecordingPane. Settings store syncs the value to debugLog.setDebugCaptureEnabled() via a subscribe listener on module load. Version 8 migration backfills debugCapture=true for older persisted states.
- [CI-04 L644] Settings store persist version 16 with incremental migrations from v0: drops tierOverrides, converts modelPatterns to routes (v0), adds model registry (v2), recording config (v3), removes globalHooks (v4), adds noisyEventKinds (v5), backfills TAP categories (v6), adds workspaceDefaults (v7), backfills debugCapture (v8), converts global routes into provider.modelMappings plus providerId/kind/predefined fields (v9), injects the predefined OpenAI Codex provider (v10), adds compressionEnabled=false (v14), removes activityViewMode (v15 — promoted to top-level rightPanelTab; transient, not persisted), adds workspaceNotes={} (v16). proxyPort is transient (not in partialize). source: src/store/settings.ts:L664

## Config Schema and Providers

- [CM-10 L102] Settings schema cached in localStorage (binarySettingsSchema) to avoid re-scanning on every startup.

## Session Launcher

- [SL-20 L227] Recent dir pruning: pruneRecentDirs() called on app init; invokes dir_exists for each recentDir in parallel, removes any that no longer exist on disk
- [SL-21 L258] Workspace-specific launch defaults: setSavedDefaults writes per-workspace entry into workspaceDefaults map (keyed by lowercased project root, worktree paths collapsed); SessionLauncher layers matching workspace defaults on mount and when switching workspace via browse or recent chip; no-entry workspace resets to global savedDefaults/lastConfig baseline; forkSession:false and other transient fields excluded from workspace entry
- [SL-08 L426] Config pruning: both `sessionNames` and `sessionConfigs` maps pruned to only IDs present in loaded past sessions
