---
paths:
  - "src/components/ConfigManager/ThreePaneEditor.tsx"
---

# src/components/ConfigManager/ThreePaneEditor.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Layout

- [CM-12 L50] ThreePaneEditor: supports optional scopes prop to control visible columns. Claude/Hooks use all 3 scopes (User/Project/Local). MCP/Agents/Skills use 2 scopes (User/Project). Color coded: User=clay, Project=blue, Local=purple (left border + tinted header).

## Config Schema and Providers

- [CM-22 L51] ThreePaneEditor scope headers show actual file paths per tab (e.g. ~/.claude/settings.json, {dir}/CLAUDE.md, {dir}/.claude/agents/) instead of generic directory stubs. Paths normalized to forward slashes via formatScopePath().
