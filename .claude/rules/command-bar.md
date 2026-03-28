---
paths:
  - "src/components/CommandBar/**"
---

# Command Bar

<!-- Codes: CB=Command Bar -->

- [CB-01] Slash command pills sorted by usage frequency, then alphabetically
- [CB-02] Heat gradient: pills show 4-tier visual heat (muted -> accent) based on usage relative to most-used command
  - Level 0: default muted (unused), Level 1: 30% accent blend, Level 2: 65% accent blend, Level 3: full accent with tinted background
- [CB-03] History bootstrap: on each launch, scans up to 200 recent JSONL files for slash command usage so heat map stays warm
- [CB-04] Click a pill types the command into the terminal without sending; Ctrl+Click sends immediately
- [CB-05] Ctrl+Click a pill sends the command to the PTY immediately (records usage on send)
- [CB-07] Holding Ctrl shows blue border on pills; heat gradient suppressed while Ctrl is held
- [CB-09] Command history strip: horizontal scrollable row above command pills showing per-session command execution history (newest left). Clicking a history pill re-sends that command. Strip only visible when history exists. Per-session -- switching tabs shows different history. Cleaned up on session close.
  - Files: src/components/CommandBar/CommandBar.tsx, src/store/sessions.ts
