---
paths:
  - "src/store/settings/types.ts"
---

# src/store/settings/types.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Per-CLI Discovery State

- [PE-02 L43] Settings store v22 splits formerly Claude-only schema/env-var caches into per-CLI maps: binarySettingsFieldsByCli, settingsSchemaByCli, knownEnvVarsByCli (Record<CliKind, ...>). loadBinarySettingsFieldsForCli(cli, cliPath?) is no-op for Codex (Codex has no Zod-style binary scan; its full schema comes via loadSettingsSchemaForCli('codex')). loadSettingsSchemaForCli routes Claude->fetch_settings_schema (schemastore.org via Rust reqwest) and Codex->discover_codex_settings_schema (binary mine + vendored fallback). loadKnownEnvVarsForCli routes Claude->discover_env_vars (claudePath) and Codex->discover_codex_env_vars (codexPath). Legacy unkeyed loadBinarySettingsSchema/loadSettingsJsonSchema/loadKnownEnvVars now delegate to the Claude variant (back-compat). v22 migration backfills binarySettingsFieldsByCli/settingsSchemaByCli/knownEnvVarsByCli .claude slot from the legacy fields (still mirrored), .codex starts empty and is populated on first Codex session via the per-CLI loaders. partialize persists both legacy and per-CLI fields.
