---
paths:
  - "src/components/ConfigManager/PromptsTab.css"
---

# src/components/ConfigManager/PromptsTab.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-28 L39] PromptsTab uses three subtabs: My Prompts, Observed Prompts, and Rules. Observed prompts and systemPromptRules are filtered by active CliKind ((item.cli ?? 'claude') === cli), so Claude and Codex prompt rules are displayed, counted, added, reordered, and generated in separate CLI scopes. The Observed Prompts tab keeps a sidebar of captured prompts plus a main pane with a single always-editable textarea seeded to rules-applied text for the current CLI. observedBaseline is captured at seed time (sidebar click or rule-driven reseed); the edited indicator and Generate Rules button appear only when observedEditText !== observedBaseline. Generate Rules produces a GeneratedChangeset; confirming adds new disabled rules via addSystemPromptRule(cli), deletes selected conflicting rules, and advances observedBaseline. The Rules list lives on its own standalone subtab with a CLI-specific header. Rule card headers use type-aware rendering via classifyRule(): Remove rules show full-width pattern text with red tint; Replace rules show pattern -> replacement at 50/50 split; Add rules show anchor + added text at 50/50 split with a + arrow.
