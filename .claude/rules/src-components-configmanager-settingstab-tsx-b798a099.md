---
paths:
  - "src/components/ConfigManager/SettingsTab.tsx"
---

# src/components/ConfigManager/SettingsTab.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Schema and Providers

- [CM-24 L30] Unified Settings Reference: full-width panel below the 3 editor columns, alphabetically sorted in a 3-column CSS grid (left-to-right flow). Type badges (boolean=blue, string=green, number=purple, enum=purple, array=yellow, object=clay), search/filter, click-to-insert into the active scope editor, 2-line CSS-clamped descriptions with full text on hover, isSet highlight when key exists in active scope. Collapse state persisted to localStorage.

## Config Editors

- [CM-06 L31] Per-scope raw JSON settings editor (SettingsPane) and CLAUDE.md editor (MarkdownPane) with own dirty tracking and Save per pane. Tab key inserts 2 spaces in markdown.
