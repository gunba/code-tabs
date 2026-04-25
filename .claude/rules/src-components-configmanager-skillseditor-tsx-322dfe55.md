---
paths:
  - "src/components/ConfigManager/SkillsEditor.tsx"
---

# src/components/ConfigManager/SkillsEditor.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Editors

- [CM-30 L31] SkillsEditor (Skills & Commands tab) lists both commands (.claude/commands/*.md, kind='command') and skills (.claude/skills/*/SKILL.md, kind='skill') from the same list_skills Rust command. The backend returns each entry with a 'kind' field. The frontend groups them (commands first, then skills) and renders a kind badge ('cmd' or 'skill') per item. New command and new skill are separate creation flows. File I/O uses fileType 'skill:<kind>:<name>' for reads/writes/deletes.
