---
paths:
  - "src/components/TabBar/Tab.tsx"
---

# src/components/TabBar/Tab.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## CLI Visual Identity

- [CV-01 L98] Tab strip CLI visual identity: Tab.tsx applies class tab-cli-${session.config.cli} to each tab and renders ProviderLogo inside .tab-cli-row.tab-cli-row-${session.config.cli}. App.css colors the provider row with var(--cli-claude) / var(--cli-codex), and the same per-tab provider scope drives --tab-active-accent plus --provider-accent/-bg/-hover from the theme/index.html provider variables. The tab has no decorative left-stripe pseudo-element in the current implementation.
