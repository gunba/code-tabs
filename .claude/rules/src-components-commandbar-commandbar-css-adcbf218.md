---
paths:
  - "src/components/CommandBar/CommandBar.css"
---

# src/components/CommandBar/CommandBar.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Command Bar

- [CB-14 L89] Command bar scroll area capped at max-height: 126px (~7 rows of pills) with overflow-y: auto, preventing the grid from growing unbounded.
- [CB-12 L126] Heat gradient expanded to 5-tier WoW rarity scale (heat-0 through heat-4): uncommon (green), rare (blue), epic (purple), legendary (orange). computeHeatLevel() in claude.ts uses thresholds 0.20, 0.50, 0.80. CSS classes use color-mix() with rarity CSS variables (--rarity-uncommon/rare/epic/legendary) defined in theme.ts. Replaces previous 4-tier inline-style heat system.
- [CB-07 L148] Holding Ctrl shows blue border on pills; heat gradient suppressed while Ctrl is held
