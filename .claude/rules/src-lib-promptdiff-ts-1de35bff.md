---
paths:
  - "src/lib/promptDiff.ts"
---

# src/lib/promptDiff.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-26 L1] promptDiff.ts: pure utility library for system prompt diffing and rule generation. Exports: escapeRegex (escape all regex metacharacters for literal matching), unescapeRegex (reverses escapeRegex for display), diffLines (LCS-based line diff returning same/add/del segments), applyRulesToText (applies SystemPromptRule[] regex replacements to prompt text, mirrors Rust proxy replace_all behavior), generateRulesFromDiff (creates add/remove/replace rules from a diff, deduplicates against existing rules), classifyRule (classifies a rule as remove/add/replace with human-readable displayLeft/displayRight text), RuleClassification (exported interface for classifyRule return value). stripAnchors is private. Used by PromptsTab to preview prompt changes, apply enabled rules, and auto-generate rules.
- [CM-29 L191] generateRulesFromDiff() in promptDiff.ts uses the raw observed prompt text (observedRawText) as the diff baseline, not the rules-applied text. Effect-equivalence deduplication: a generated hunk is skipped if applying the currently-enabled existing rules to the hunk's deleted lines already produces the hunk's added lines (applyRulesToText(deletedText, enabledExisting) === expected). This prevents generating redundant rules when the diff baseline is raw and existing rules already account for some changes.
- [CM-31 L294] generateRulesAndConflicts(original, edited, existingRules) in promptDiff.ts: greedy minimal-removal simulation that finds adds (new rules needed) + deletes (existing enabled rules blocking the outcome) to transform original -> edited. Returns GeneratedChangeset { adds, deletes, unresolvedDrift }. Quick exit if existing+new already produces edited. Otherwise, iteratively removes the enabled rule whose absence most improves diffDistance(simulate(), edited); stops when no improvement possible. After removals, regenerates adds against the survivor set so effect-equivalence dedup in generateRulesFromDiff doesn't hide still-needed rules. Uses diffDistance helper (count of non-same diff lines).
