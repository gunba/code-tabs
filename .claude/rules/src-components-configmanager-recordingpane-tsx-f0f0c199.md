---
paths:
  - "src/components/ConfigManager/RecordingPane.tsx"
---

# src/components/ConfigManager/RecordingPane.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Layout

- [CM-27 L171] RecordingPane groups TAP category toggles by subsystem (via TAP_CATEGORY_GROUPS from tapCatalog.ts) and shows each category's human label and its hook source (e.g. 'fs.readFileSync() / writeFileSync()...') as secondary text. The raw category key is not displayed — it is used only as the React key and for checkbox state lookup.
