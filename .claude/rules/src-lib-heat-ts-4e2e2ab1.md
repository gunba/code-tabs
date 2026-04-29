---
paths:
  - "src/lib/heat.ts"
---

# src/lib/heat.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Command Bar

- [CB-12 L3] Heat gradient 5-tier WoW rarity scale heat-0..heat-4 (common=white, uncommon=green, rare=blue, epic=purple, legendary=orange). Tiers assigned by rank-based quartiles over used commands: unused commands get heat-0 (common/white). CSS classes use color-mix() with --rarity-* CSS variables defined in applyTheme(). source: src/components/CommandBar/CommandBar.css:L126; src/lib/claude.ts:L254; src/lib/theme.ts:L145
- [CB-10 L16] Heat gradient uses CSS classes heat-0..heat-4. heatClassName(level) returns 'heat-${level}'. computeHeatLevel(count, rank, totalUsed) returns 0-4: count<=0 or totalUsed<=0 -> 0 (common/white), totalUsed==1 -> 4, otherwise rank-based quartiles over used commands (rank/totalUsed-1 < 0.25 -> 4, < 0.50 -> 3, < 0.75 -> 2, else -> 1). source: src/lib/claude.ts:L254,L274
