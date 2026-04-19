---
paths:
  - "src/lib/settingsSchema.ts"
---

# src/lib/settingsSchema.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Implementation

- [CI-03 L225] Settings schema discovery uses 4-tier priority: (1) JSON Schema from schemastore.org fetched via Rust fetch_settings_schema command (reqwest, avoids CORS), cached in localStorage by CLI version; (2) CLI --help flag parsing; (3) Binary Zod regex scan; (4) Static field registry. parseJsonSchema() unwraps Zod anyOf optionals, maps JSON Schema types to SettingField types, extracts descriptions/enums. buildSettingsSchema() deduplicates across all tiers.

## Config Schema and Providers

- [CM-33 L158] Boolean setting default: defaultForType() in settingsSchema.ts returns true for boolean fields (changed from false in commit 400d0ee). When the user clicks 'Add' for a boolean setting in the Settings Reference, the inserted value defaults to true (opt-in behavior). Enum fields still default to the first choice; string defaults to empty string; number to 0.
  - src/lib/settingsSchema.ts:L159
- [CM-03 L224] Project directory selector: when multiple working dirs exist across sessions, the config modal header shows a dropdown to switch between project-level scopes. settingsSchema.ts builds the schema; fetch_settings_schema provides the Rust backend.

## Config Editors

- [CM-25 L358] Settings validation footer: shows "Valid" when JSON is well-formed with all recognized keys. Unknown keys show names inline (up to 3, then "+N more") with a tooltip explaining schema source status. Type mismatches show key, expected type, and actual type. Each validation segment is a separate span so tooltips are correctly scoped.
