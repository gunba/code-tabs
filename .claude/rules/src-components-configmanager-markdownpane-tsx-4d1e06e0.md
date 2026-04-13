---
paths:
  - "src/components/ConfigManager/MarkdownPane.tsx"
---

# src/components/ConfigManager/MarkdownPane.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-14 L7] MarkdownPane: per-scope CLAUDE.md textarea. Tab key inserts 2 spaces. Scope-to-fileType mapping: user=claudemd-user, project=claudemd-root, project-local=claudemd-local. Local scope writes to CLAUDE.local.md at project root (Claude Code convention).
- [CM-23 L87] MarkdownPane preview toggle: footer has Preview/Edit button (left-aligned via margin-right:auto). Preview mode renders markdown via ReactMarkdown with dark-themed styles.
