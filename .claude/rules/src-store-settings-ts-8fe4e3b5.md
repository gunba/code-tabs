---
paths:
  - "src/store/settings.ts"
---

# src/store/settings.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## RightPanel

- [RI-02 L642] activityViewMode ('response' | 'session') is stored as a global persisted setting in useSettingsStore, not per-session in the activity store. setActivityViewMode() in useSettingsStore updates it. RightPanel reads mode and setMode from useSettingsStore (not useActivityStore). The value persists across sessions and app restarts via localStorage.

## Config Implementation

- [CI-05 L37] Recording defaults: TAP/traffic enabled, debugCapture enabled, stdout/stderr off. Migrations backfill expanded TAP categories (v6) and debugCapture=true (v8).
  - Defaults keep TAP/traffic enabled, force stdout/stderr off, and seed fspromises, bunfile, abort, fswatch, textdecoder, events, and envproxy category toggles.
  - The version < 6 migration forces stdout/stderr=false and only fills the new category keys when they are absent in persisted state.
- [CI-06 L38] RecordingConfig.debugCapture toggle: a boolean field in RecordingConfig (default true) controls whether DEBUG-level entries are captured. Toggled via a checkbox in RecordingPane. Settings store syncs the value to debugLog.setDebugCaptureEnabled() via a subscribe listener on module load. Version 8 migration backfills debugCapture=true for older persisted states.
- [CI-04 L657] Settings store persist version 10 with incremental migrations from v0: drops tierOverrides, converts modelPatterns to routes (v0), adds model registry (v2), recording config (v3), removes globalHooks (v4), adds noisyEventKinds (v5), backfills TAP categories (v6), adds workspaceDefaults (v7), backfills debugCapture (v8), converts global routes into provider.modelMappings plus providerId/kind/predefined fields (v9), and injects the predefined OpenAI Codex provider (v10). proxyPort is transient (not in partialize).

## Config Schema and Providers

- [CM-10 L108] Settings schema cached in localStorage (binarySettingsSchema) to avoid re-scanning on every startup.

## Session Launcher

- [SL-20 L240] Recent dir pruning: pruneRecentDirs() called on app init; invokes dir_exists for each recentDir in parallel, removes any that no longer exist on disk
- [SL-21 L271] Workspace-specific launch defaults: setSavedDefaults writes per-workspace entry into workspaceDefaults map (keyed by lowercased project root, worktree paths collapsed); SessionLauncher layers matching workspace defaults on mount and when switching workspace via browse or recent chip; no-entry workspace resets to global savedDefaults/lastConfig baseline; forkSession:false and other transient fields excluded from workspace entry
- [SL-08 L430] Config pruning: both `sessionNames` and `sessionConfigs` maps pruned to only IDs present in loaded past sessions

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-02 L759] OpenAI Codex is exposed as a predefined openai_codex provider with canonical primary/small models, 272k context mappings, and persisted-config migration backfills; ProvidersPane shows OAuth login/logout state, SessionLauncher blocks non-utility Codex launches until auth is available, and the Rust adapter translates Anthropic-style requests and streaming responses through the OpenAI Responses API.
