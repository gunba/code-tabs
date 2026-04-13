---
paths:
  - "src/components/ConfigManager/PromptsTab.tsx"
---

# src/components/ConfigManager/PromptsTab.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-28 L183] PromptsTab uses three subtabs: My Prompts, Observed Prompts, and Rules. The Observed Prompts tab keeps a sidebar of captured prompts plus a main pane that shows rules-applied text or an inline original-vs-edited diff, and editing mode splits the textarea with a live diff preview. The Rules list lives on its own standalone subtab. Rule card headers use type-aware rendering via classifyRule(): Remove rules show full-width pattern text with red tint; Replace rules show pattern -> replacement at 50/50 split; Add rules show anchor + added text at 50/50 split with a + arrow.
- [CM-26 L254] promptDiff.ts: pure utility library for system prompt diffing and rule generation. Exports: escapeRegex (escape all regex metacharacters for literal matching), unescapeRegex (reverses escapeRegex for display), diffLines (LCS-based line diff returning same/add/del segments), applyRulesToText (applies SystemPromptRule[] regex replacements to prompt text, mirrors Rust proxy replace_all behavior), generateRulesFromDiff (creates add/remove/replace rules from a diff, deduplicates against existing rules), classifyRule (classifies a rule as remove/add/replace with human-readable displayLeft/displayRight text), RuleClassification (exported interface for classifyRule return value). stripAnchors is private. Used by PromptsTab to preview prompt changes, apply enabled rules, and auto-generate rules.
