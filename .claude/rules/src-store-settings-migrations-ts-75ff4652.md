---
paths:
  - "src/store/settings/migrations.ts"
---

# src/store/settings/migrations.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Per-CLI Discovery State

- [PE-02 L184] Settings store v22 splits formerly Claude-only schema/env-var caches into per-CLI maps: binarySettingsFieldsByCli, settingsSchemaByCli, knownEnvVarsByCli (Record<CliKind, ...>). loadBinarySettingsFieldsForCli(cli, cliPath?) is no-op for Codex (Codex has no Zod-style binary scan; its full schema comes via loadSettingsSchemaForCli('codex')). loadSettingsSchemaForCli routes Claude->fetch_settings_schema (schemastore.org via Rust reqwest) and Codex->discover_codex_settings_schema (binary mine + vendored fallback). loadKnownEnvVarsForCli routes Claude->discover_env_vars (claudePath) and Codex->discover_codex_env_vars (codexPath). Legacy unkeyed loadBinarySettingsSchema/loadSettingsJsonSchema/loadKnownEnvVars now delegate to the Claude variant (back-compat). v22 migration backfills binarySettingsFieldsByCli/settingsSchemaByCli/knownEnvVarsByCli .claude slot from the legacy fields (still mirrored), .codex starts empty and is populated on first Codex session via the per-CLI loaders. partialize persists both legacy and per-CLI fields.

## Notes Panel

- [NP-02 L100] workspaceNotes persist migration: settings store v16 adds workspaceNotes field (backfilled as empty object {} for older persisted states in version<16 migration). workspaceNotes is included in the partialize list so it persists across restarts. source: src/store/settings.ts:L102,L827

## Config Implementation

- [CI-04 L19] Settings store persist version 26 uses incremental migrations from v0: drops tierOverrides and converts legacy modelPatterns to routes (v0), adds model registry (v2), recording config (v3), removes globalHooks (v4), backfills noisyEventKinds/TAP categories (v5-v6), adds workspaceDefaults (v7), backfills debugCapture (v8), cleans stale provider/activity/compression fields (v9/v14/v15), adds workspaceNotes={} (v16), splits CLI capabilities/versions/slash commands/default configs into per-CLI maps and defaults legacy sessions to Claude (v17), adds Codex TAP categories (v18), splits recording configs by CLI (v19-v23), deletes legacy unkeyed CLI/schema fields (v24), clears persisted settingsSchemaByCli runtime-discovery cache (v25), and duplicates legacy unscoped systemPromptRules into Claude- and Codex-scoped copies with deterministic fallback ids while preserving already-scoped rules (v26). proxyPort remains transient and is excluded by partialize.
