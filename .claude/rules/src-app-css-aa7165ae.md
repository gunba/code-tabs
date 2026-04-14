---
paths:
  - "src/App.css"
---

# src/App.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Resume

- [SR-04 L488] Subagent cards (in App.tsx subagent bar) use --bg-surface base; idle/dead cards fade (opacity 0.45), interrupted cards color the name red (var(--error)), completed cards show full opacity with a checkmark. Selected cards get accent-secondary tint and bottom bar when their inspector is open.

## Terminal UI

- [TA-03 L171] .tab-activity CSS: single-line (white-space: nowrap, text-overflow: ellipsis), 10px font, font-weight 500, no clamp. Replaces old .tab-summary (2-line clamp, 9px). Saves ~10px vertical space, fixing meta label overflow at 66px tab height.
- [TR-11 L563] Subagent card shows selected highlight (accent-secondary box-shadow + tinted background) when its inspector is open.
