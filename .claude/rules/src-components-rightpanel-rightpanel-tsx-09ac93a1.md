---
paths:
  - "src/components/RightPanel/RightPanel.tsx"
---

# src/components/RightPanel/RightPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## RightPanel

- [RI-04 L13] BASE_TABS in RightPanel.tsx is ordered [search, activity, debug] so that when the Search tab becomes visible (hasExecutedSearch), it appears before Activity in the tab bar. Response/Session pills (rendered after Activity) do not shift the Search tab position because Search is always first in the ordered list and filtered out when hidden.
- [RI-03 L30] Search tab conditional visibility: the 'search' tab is hidden from the RightPanel tab bar until hasExecutedSearch is true in useRuntimeStore (not persisted — resets on app restart). markSearchExecuted() is called before the IPC invoke in SearchPanel.executeSearch() and in the Ctrl+Shift+F handler in App.tsx, so a failed search still reveals the tab. RightPanel's useEffect redirects the active tab from 'search' to 'activity' when hasExecutedSearch is false.
- [RI-01 L50] The Response/Session view-mode toggle pill is rendered inline in the RightPanel tab row immediately after the 'Activity' tab button, not inside ActivityPanel. It is only visible when the Activity tab is active and a session is open (showPill = activeTab === 'activity' && !!activeTabId). The pill controls useSettingsStore.setActivityViewMode() — a global persisted setting, not per-session state. mode and setMode are sourced from useSettingsStore.
