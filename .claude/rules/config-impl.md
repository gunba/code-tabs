---
paths:
  - "src/components/ConfigManager/**"
  - "src/lib/settingsSchema.ts"
  - "src/lib/paths.ts"
---

# Config Implementation

<!-- Codes: CI=Config Implementation -->

- [CI-01] Config modal header uses CSS grid (1fr auto 1fr) instead of flexbox space-between, so tab row stays centered regardless of left (title) or right (project selector + close) content width.
  - Files: src/components/ConfigManager/ConfigManager.css, src/components/ConfigManager/ConfigManager.tsx
- [CI-02] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.
  - Files: src/lib/paths.ts
- [CI-03] Settings schema discovery uses 4-tier priority: (1) JSON Schema from schemastore.org fetched via Rust fetch_settings_schema command (reqwest, avoids CORS), cached in localStorage by CLI version; (2) CLI --help flag parsing; (3) Binary Zod regex scan; (4) Static field registry. parseJsonSchema() unwraps Zod anyOf optionals, maps JSON Schema types to SettingField types, extracts descriptions/enums. buildSettingsSchema() deduplicates across all tiers.
  - Files: src/lib/settingsSchema.ts, src-tauri/src/commands.rs, src/store/settings.ts
- [CI-04] Settings store provider config: providerConfig (ProviderConfig with providers + routes + defaultProviderId) persisted to localStorage. Zustand persist version 1 with migration from version 0: drops tierOverrides, converts old modelPatterns on providers into ModelRoute entries, ensures catch-all route exists. proxyPort is transient (not in partialize).
  - Files: src/store/settings.ts, src/types/session.ts
