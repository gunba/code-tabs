---
paths:
  - "src/components/ConfigManager/PromptsTab.css"
---

# src/components/ConfigManager/PromptsTab.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-28 L39] PromptsTab uses three subtabs: My Prompts, Observed Prompts, and Rules. The Observed Prompts tab keeps a sidebar of captured prompts plus a main pane that shows rules-applied text or an inline original-vs-edited diff, and editing mode splits the textarea with a live diff preview. The Rules list lives on its own standalone subtab. Rule card headers use type-aware rendering via classifyRule(): Remove rules show full-width pattern text with red tint; Replace rules show pattern -> replacement at 50/50 split; Add rules show anchor + added text at 50/50 split with a + arrow.
