---
paths:
  - "src/components/ConfigManager/SettingsPane.tsx"
---

# src/components/ConfigManager/SettingsPane.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-13 L16] SettingsPane: JSON textarea with syntax highlighting overlay (pre behind transparent textarea). Both layers use position: absolute; inset: 0 inside sh-container for proper fill. Keys=clay, strings=blue, numbers/bools=purple. Scroll synced between layers. Ctrl+S to save.
- [CM-25 L323] Settings validation footer: shows "Valid" when JSON is well-formed with all recognized keys. Unknown keys show names inline (up to 3, then "+N more") with a tooltip explaining schema source status. Type mismatches show key, expected type, and actual type. Each validation segment is a separate span so tooltips are correctly scoped.
