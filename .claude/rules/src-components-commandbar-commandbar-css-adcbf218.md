---
paths:
  - "src/components/CommandBar/CommandBar.css"
---

# src/components/CommandBar/CommandBar.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Command Bar

- [CB-14 L89] Command bar scroll area capped at max-height: 126px (~7 rows of pills) with overflow-y: auto, preventing the grid from growing unbounded.
- [CB-12 L126] Heat gradient 5-tier WoW rarity scale heat-0..heat-4 (common=white, uncommon=green, rare=blue, epic=purple, legendary=orange). Tiers assigned by rank-based quartiles over used commands: unused commands get heat-0 (common/white). CSS classes use color-mix() with --rarity-* CSS variables defined in applyTheme(). source: src/components/CommandBar/CommandBar.css:L126; src/lib/claude.ts:L254; src/lib/theme.ts:L145
- [CB-07 L156] Holding Ctrl shows blue border on pills; heat gradient suppressed while Ctrl is held
