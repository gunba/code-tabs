---
paths:
  - "src/lib/theme.ts"
---

# src/lib/theme.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Command Bar

- [CB-12 L144] Heat gradient expanded to 5-tier WoW rarity scale (heat-0 through heat-4): uncommon (green), rare (blue), epic (purple), legendary (orange). computeHeatLevel() in claude.ts uses thresholds 0.20, 0.50, 0.80. CSS classes use color-mix() with rarity CSS variables (--rarity-uncommon/rare/epic/legendary) defined in theme.ts. Replaces previous 4-tier inline-style heat system.

## Theme System

- [TH-01 L4] All colors are CSS custom properties on `:root` — components use CSS variables, not hardcoded hex (exception: model rarity colors in `claude.ts` are fixed hex for cross-theme consistency). Applied at startup via `applyTheme()`. xterm.js colors from `getXtermTheme()` reading CSS variables.
- [TH-02 L5] Key variables: `--bg-primary`, `--bg-surface`, `--accent` (clay), `--accent-secondary` (blue), `--accent-tertiary` (purple), `--term-bg`, `--term-fg`
