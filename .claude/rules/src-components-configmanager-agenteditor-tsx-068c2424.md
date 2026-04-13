---
paths:
  - "src/components/ConfigManager/AgentEditor.tsx"
---

# src/components/ConfigManager/AgentEditor.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-07 L6] Agent editor: scoped via ThreePaneEditor (user/project only -- no local scope) with agent pills at top, editor below. Auto-selects first agent on load (or enters new-agent mode if none). Textarea always visible -- no empty state. Dashed "+ new agent" pill replaces old + New button/inline form. Duplicate name validation on create. Ctrl+S dispatches to create or save based on mode. User scope scans ~/.claude/agents/, project scans {wd}/.claude/agents/.
