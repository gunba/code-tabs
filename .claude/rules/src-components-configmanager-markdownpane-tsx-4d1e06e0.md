---
paths:
  - "src/components/ConfigManager/MarkdownPane.tsx"
---

# src/components/ConfigManager/MarkdownPane.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-14 L8] MarkdownPane: per-scope CLAUDE.md textarea. Tab key inserts 2 spaces. Scope-to-fileType mapping: user=claudemd-user, project=claudemd-root, project-local=claudemd-local. Local scope writes to CLAUDE.local.md at project root (Claude Code convention).
- [CM-23 L148] MarkdownPane preview toggle: footer has Preview/Edit button (left-aligned via margin-right:auto). Preview mode renders markdown via ReactMarkdown with dark-themed styles.

## Native Undo Textareas

- [NU-01 L128] Long-form textareas in NotesPanel, MarkdownPane, SkillsEditor, AgentEditor, SettingsPane, EnvVarsTab, PromptsTab, and McpPane converted from controlled (value+onChange) to uncontrolled (defaultValue+onInput) so the browser owns the textarea value and its native undo stack mid-edit. React mirrors state via onInput for validation/overlays. key={seedKey} remounts the textarea on genuine source changes (load complete, selection switch, scope change) to reseed defaultValue. Programmatic insertions (e.g. tab-key indent) go through insertTextAtCursor (domEdit.ts) to preserve the native undo stack.
