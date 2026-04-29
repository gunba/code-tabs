---
paths:
  - "src/components/ConfigManager/TextFileEditor.tsx"
---

# src/components/ConfigManager/TextFileEditor.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-34 L33] Shared text-file editor lifecycle
  - useTextFileEditor centralizes config-pane load/save/dirty/seed/external-refresh behavior for uncontrolled textarea-based editors. It loads a Tauri config file by fileType/scope/workingDir, tracks savedContent vs current content, registers with the unsaved-change guard, reseeds via seedKey only on load/save/external refresh, watches the backing config file for external changes, and exposes an external-change notice plus save/discard/reload handlers for panes such as MarkdownPane, SettingsPane, EnvVarsTab, McpPane, HooksPane, and PluginsPane.

## Native Undo Textareas

- [NU-01 L157] Long-form textareas in NotesPanel, MarkdownPane, SkillsEditor, AgentEditor, SettingsPane, EnvVarsTab, PromptsTab, and McpPane converted from controlled (value+onChange) to uncontrolled (defaultValue+onInput) so the browser owns the textarea value and its native undo stack mid-edit. React mirrors state via onInput for validation/overlays. key={seedKey} remounts the textarea on genuine source changes (load complete, selection switch, scope change) to reseed defaultValue. Programmatic insertions (e.g. tab-key indent) go through insertTextAtCursor (domEdit.ts) to preserve the native undo stack.
