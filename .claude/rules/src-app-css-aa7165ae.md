---
paths:
  - "src/App.css"
---

# src/App.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## CLI Visual Identity

- [CV-01 L62] Tab strip CLI stripe: tabs get class tab-cli-${session.config.cli} (e.g. tab-cli-claude or tab-cli-codex). CSS ::before pseudo-element adds a 3px left edge stripe inside the tab: orange (#ff8000) for Claude, teal (#10a37f) for Codex. Stripe is purely decorative (pointer-events:none) and doesn't disturb layout.

## Session Resume

- [SR-04 L487] Subagent cards (in App.tsx subagent bar) use --bg-surface base; idle/dead cards fade (opacity 0.45), interrupted cards color the name red (var(--error)), completed cards show full opacity with a checkmark. Selected cards get accent-secondary tint and bottom bar when their inspector is open.

## Terminal UI

- [TA-03 L192] .tab-activity CSS: single-line (white-space: nowrap, text-overflow: ellipsis), 10px font, font-weight 500, no clamp. Replaces old .tab-summary (2-line clamp, 9px). Saves ~10px vertical space, fixing meta label overflow at 66px tab height.
- [TR-11 L562] Subagent card shows selected highlight (accent-secondary box-shadow + tinted background) when its inspector is open.
