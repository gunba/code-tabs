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

- [CI-04 L19] Settings store persist version 16 with incremental migrations from v0: drops tierOverrides, converts modelPatterns to routes (v0), adds model registry (v2), recording config (v3), removes globalHooks (v4), adds noisyEventKinds (v5), backfills TAP categories (v6), adds workspaceDefaults (v7), backfills debugCapture (v8), converts global routes into provider.modelMappings plus providerId/kind/predefined fields (v9), injects the predefined OpenAI Codex provider (v10), adds compressionEnabled=false (v14), removes activityViewMode (v15 — promoted to top-level rightPanelTab; transient, not persisted), adds workspaceNotes={} (v16). proxyPort is transient (not in partialize). source: src/store/settings.ts:L664
