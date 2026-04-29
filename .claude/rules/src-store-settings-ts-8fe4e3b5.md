---
paths:
  - "src/store/settings.ts"
---

# src/store/settings.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Per-CLI Discovery State

- [PE-01 L193] settings store holds cliCapabilitiesByCli: Record<CliKind, CliCapabilities>, slashCommandsByCli: Record<CliKind, SlashCommand[]>, and cliVersions: Record<CliKind, string|null> (CliKind = 'claude'|'codex'). v17 migration backfills cliCapabilitiesByCli from legacy cliCapabilities, cliVersions from legacy cliVersion, slashCommandsByCli from legacy slashCommands (codex fields empty), and within the same version<17 guard backfills lastConfig.cli, savedDefaults.cli, and every workspaceDefaults entry's cli to 'claude'. setCliCapabilitiesForCli(cli, version, capabilities) updates the per-CLI maps and mirrors Claude into the legacy single-CLI cliVersion/cliCapabilities fields for back-compat. setSlashCommandsForCli(cli, cmds) updates slashCommandsByCli and rebuilds the merged slashCommands list as [...claude, ...codex]. setSlashCommands(cmds) continues mirroring Claude into slashCommandsByCli.claude and the merged slashCommands. setSavedDefaults serialises wsDefaults including cli so workspace switches restore the chosen CLI.
- [PE-02 L334,376,435] Settings store v22 splits formerly Claude-only schema/env-var caches into per-CLI maps: binarySettingsFieldsByCli, settingsSchemaByCli, knownEnvVarsByCli (Record<CliKind, ...>). loadBinarySettingsFieldsForCli(cli, cliPath?) is no-op for Codex (Codex has no Zod-style binary scan; its full schema comes via loadSettingsSchemaForCli('codex')). loadSettingsSchemaForCli routes Claude->fetch_settings_schema (schemastore.org via Rust reqwest) and Codex->discover_codex_settings_schema (binary mine + vendored fallback). loadKnownEnvVarsForCli routes Claude->discover_env_vars (claudePath) and Codex->discover_codex_env_vars (codexPath). Legacy unkeyed loadBinarySettingsSchema/loadSettingsJsonSchema/loadKnownEnvVars now delegate to the Claude variant (back-compat). v22 migration backfills binarySettingsFieldsByCli/settingsSchemaByCli/knownEnvVarsByCli .claude slot from the legacy fields (still mirrored), .codex starts empty and is populated on first Codex session via the per-CLI loaders. partialize persists both legacy and per-CLI fields.

## Config Schema and Providers

- [CM-10 L376] Settings JSON schemas are persisted per CLI in the zustand settingsSchemaByCli map. loadSettingsSchemaForCli('claude') fetches the Claude settings JSON schema through fetch_settings_schema; loadSettingsSchemaForCli('codex') invokes discover_codex_settings_schema and stores result.schema. Migration v22 backfills settingsSchemaByCli.claude from legacy settingsJsonSchema with codex null, migration v24 deletes legacy unkeyed discovery caches, and partialize persists settingsSchemaByCli so settings panes do not re-fetch or re-mine schemas on every startup.

## Session Launcher

- [SL-20 L110] Recent dir pruning: pruneRecentDirs() called on app init; invokes dir_exists for each recentDir in parallel, removes any that no longer exist on disk
- [SL-21 L141] Workspace-specific launch defaults: setSavedDefaults writes per-workspace entry into workspaceDefaults map (keyed by lowercased project root, worktree paths collapsed); SessionLauncher layers matching workspace defaults on mount and when switching workspace via browse or recent chip; no-entry workspace resets to global savedDefaults/lastConfig baseline; forkSession:false and other transient fields excluded from workspace entry
- [SL-08 L306] Config pruning: both `sessionNames` and `sessionConfigs` maps pruned to only IDs present in loaded past sessions
