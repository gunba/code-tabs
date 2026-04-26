---
paths:
  - "src/components/RightPanel/RightPanel.tsx"
---

# src/components/RightPanel/RightPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Debug Panel

- [DP-02 L66] DebugPanel is shown as a tab inside RightPanel when activeTab === 'debug' (and debugBuild is true). There is no dedicated keyboard shortcut to toggle it — users switch RightPanel tabs via the tab row at the top of the panel.

## RightPanel

- [RI-04 L13] BASE_TABS in RightPanel.tsx is ordered [search, response, session, notes, debug]. Activity tab was removed in 8d454f3 — replaced by top-level Response and Session tabs that each render ActivityPanel with a mode prop ('response' or 'session'). The legacy activityViewMode setting was migrated away (settings.ts v913). Debug tab filtered out unless debugBuild. Notes tab added later for in-app session notes.
