---
paths:
  - "src/store/settings/partialize.ts"
---

# src/store/settings/partialize.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Schema and Providers

- [CM-10 L20] Settings JSON schemas are persisted per CLI in the zustand settingsSchemaByCli map. loadSettingsSchemaForCli('claude') fetches the Claude settings JSON schema through fetch_settings_schema; loadSettingsSchemaForCli('codex') invokes discover_codex_settings_schema and stores result.schema. Migration v22 backfills settingsSchemaByCli.claude from legacy settingsJsonSchema with codex null, migration v24 deletes legacy unkeyed discovery caches, and partialize persists settingsSchemaByCli so settings panes do not re-fetch or re-mine schemas on every startup.
