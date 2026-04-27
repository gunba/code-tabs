---
paths:
  - "src/store/settings.ts"
---

# src/store/settings.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Per-CLI Discovery State

- [PE-02 L210,273,651,694,754,1089] Settings store v22 splits formerly Claude-only schema/env-var caches into per-CLI maps: binarySettingsFieldsByCli, settingsSchemaByCli, knownEnvVarsByCli (Record<CliKind, ...>). loadBinarySettingsFieldsForCli(cli, cliPath?) is no-op for Codex (Codex has no Zod-style binary scan; its full schema comes via loadSettingsSchemaForCli('codex')). loadSettingsSchemaForCli routes Claude->fetch_settings_schema (schemastore.org via Rust reqwest) and Codex->discover_codex_settings_schema (binary mine + vendored fallback). loadKnownEnvVarsForCli routes Claude->discover_env_vars (claudePath) and Codex->discover_codex_env_vars (codexPath). Legacy unkeyed loadBinarySettingsSchema/loadSettingsJsonSchema/loadKnownEnvVars now delegate to the Claude variant (back-compat). v22 migration backfills binarySettingsFieldsByCli/settingsSchemaByCli/knownEnvVarsByCli .claude slot from the legacy fields (still mirrored), .codex starts empty and is populated on first Codex session via the per-CLI loaders. partialize persists both legacy and per-CLI fields.
- [PE-01 L469] settings store holds cliCapabilitiesByCli: Record<CliKind, CliCapabilities>, slashCommandsByCli: Record<CliKind, SlashCommand[]>, and cliVersions: Record<CliKind, string|null> (CliKind = 'claude'|'codex'). v17 migration backfills cliCapabilitiesByCli from legacy cliCapabilities, cliVersions from legacy cliVersion, slashCommandsByCli from legacy slashCommands (codex fields empty), and within the same version<17 guard backfills lastConfig.cli, savedDefaults.cli, and every workspaceDefaults entry's cli to 'claude'. setCliCapabilitiesForCli(cli, version, capabilities) updates the per-CLI maps and mirrors Claude into the legacy single-CLI cliVersion/cliCapabilities fields for back-compat. setSlashCommandsForCli(cli, cmds) updates slashCommandsByCli and rebuilds the merged slashCommands list as [...claude, ...codex]. setSlashCommands(cmds) continues mirroring Claude into slashCommandsByCli.claude and the merged slashCommands. setSavedDefaults serialises wsDefaults including cli so workspace switches restore the chosen CLI.

## Notes Panel

- [NP-02 L1015] workspaceNotes persist migration: settings store v16 adds workspaceNotes field (backfilled as empty object {} for older persisted states in version<16 migration). workspaceNotes is included in the partialize list so it persists across restarts. source: src/store/settings.ts:L102,L827

## Config Implementation

- [CI-05 L35] Recording defaults: TAP/traffic disabled, debugCapture disabled, all high-volume tap categories off (console, fs, spawn, fetch, exit, timer, stdout, stderr, require, bun, websocket, net, stream, fspromises, bunfile, abort, fswatch, textdecoder, events, envproxy). parse, stringify, codex-* (codex-session/turn-context/token-count/tool-call-start/tool-input/tool-call-complete/message/thread-name-updated/compacted), and system-prompt categories on. v6 backfilled added categories with stdout/stderr forced off; v21 quietRecordingConfig force-quiets persisted configs into recordingConfigsByCli (claude+codex).
  - Defaults keep TAP/traffic enabled, force stdout/stderr off, and seed fspromises, bunfile, abort, fswatch, textdecoder, events, and envproxy category toggles.
  - The version < 6 migration forces stdout/stderr=false and only fills the new category keys when they are absent in persisted state.
- [CI-06 L36] RecordingConfig.debugCapture field controls DEBUG-level capture (default false). Toggled via RecordingPane checkbox. Settings store syncs to debugLog.setDebugCaptureEnabled() via subscribe; setDebugCaptureResolver wires resolveDebugCaptureForSession (per-CLI lookup via session.config.cli or sessionConfigs cache). v8 backfilled true for older states; v21 force-quiets to false alongside the other recording defaults.
- [CI-04 L934] Settings store persist version 16 with incremental migrations from v0: drops tierOverrides, converts modelPatterns to routes (v0), adds model registry (v2), recording config (v3), removes globalHooks (v4), adds noisyEventKinds (v5), backfills TAP categories (v6), adds workspaceDefaults (v7), backfills debugCapture (v8), converts global routes into provider.modelMappings plus providerId/kind/predefined fields (v9), injects the predefined OpenAI Codex provider (v10), adds compressionEnabled=false (v14), removes activityViewMode (v15 — promoted to top-level rightPanelTab; transient, not persisted), adds workspaceNotes={} (v16). proxyPort is transient (not in partialize). source: src/store/settings.ts:L664

## Config Schema and Providers

- [CM-10 L218] Settings schema cached in localStorage (binarySettingsSchema) to avoid re-scanning on every startup.

## Session Launcher

- [SL-20 L370] Recent dir pruning: pruneRecentDirs() called on app init; invokes dir_exists for each recentDir in parallel, removes any that no longer exist on disk
- [SL-21 L401] Workspace-specific launch defaults: setSavedDefaults writes per-workspace entry into workspaceDefaults map (keyed by lowercased project root, worktree paths collapsed); SessionLauncher layers matching workspace defaults on mount and when switching workspace via browse or recent chip; no-entry workspace resets to global savedDefaults/lastConfig baseline; forkSession:false and other transient fields excluded from workspace entry
- [SL-08 L614] Config pruning: both `sessionNames` and `sessionConfigs` maps pruned to only IDs present in loaded past sessions
