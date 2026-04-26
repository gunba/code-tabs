---
paths:
  - "src/components/CommandBar/CommandBar.tsx"
---

# src/components/CommandBar/CommandBar.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Command Bar

- [CB-01 L50] Slash command pills sorted by usage frequency, then alphabetically
- [CB-05 L69] Ctrl+Click a pill sends the command to the PTY immediately (records usage on send)
- [CB-04 L72] Click a pill types the command into the terminal without sending; Ctrl+Click sends immediately
- [CB-11 L107] Command bar layout: history strip always visible; toggle chevron shows/hides the slash-command grid only (not history). Previously, collapsing hid both history and commands.
- [CB-09 L135] Command history strip: horizontal scrollable row above command pills showing per-session command execution history (newest left). Clicking a history pill re-sends that command. Strip only visible when history exists. Per-session -- switching tabs shows different history. Cleaned up on session close.
- [CB-13 L135] Skill invocations interleaved into command history strip: SkillInvocation results from useSessionStore.skillInvocations are merged with command history (newest first) into the same .command-history row. Skill entries get an extra .skill-history-item class (and .skill-failed when success=false) for distinct coloring. Clicking re-sends the slash command.
