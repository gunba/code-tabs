---
paths:
  - "src/components/ConfigManager/HooksPane.tsx"
  - "src/components/StatusBar/**"
---

# Hooks Manager

<!-- Codes: HM=Hooks Manager -->

- [HM-01] Three scopes: User (`~/.claude/settings.json`), Project (`.claude/settings.json`), Project Local (`.claude/settings.local.json`)
- [HM-02] Scope separation: Rust backend returns distinct keys per scope — project and project-local hooks never conflated
- [HM-03] Non-destructive saves: merges hooks into existing settings file (preserves other keys like `permissions`)
- [HM-04] Edit preserves unknown fields: editing a hook spreads the original entry before applying form values, so fields added by future CLI versions are not stripped
- [HM-05] Custom events: event dropdown includes a "Custom event..." option with freeform text input, so users aren't locked to the hardcoded event list
- [HM-06] Existing hooks with unknown event names (from file) are displayed and editable
- [HM-07] Status bar hook count reflects actual hook entries (sums `hooks[]` within each `MatcherGroup`), not matcher group count
- [HM-08] StatusBar total tokens: when >1 non-dead session exists, shows `Σ` total token count across all active sessions in the right section
- [HM-09] Three hook types supported: `command`, `prompt`, `agent`
- [HM-10] All status bar icons (context, tokens, clock, budget, warning, hooks, sessions, permissions, tap indicator) are inline SVG components -- no emoji. Greek sigma kept as text.
  - Files: src/components/StatusBar/StatusBar.tsx
