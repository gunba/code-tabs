---
paths:
  - "src/components/ConfigManager/RecordingPane.tsx"
---

# src/components/ConfigManager/RecordingPane.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Layout

- [CM-27 L260] RecordingPane groups TAP category toggles by subsystem (via TAP_CATEGORY_GROUPS from tapCatalog.ts) and shows each category's human label and its hook source (e.g. 'fs.readFileSync() / writeFileSync()...') as secondary text. The raw category key is not displayed — it is used only as the React key and for checkbox state lookup.

## Debug Panel

- [DP-17 L192] RecordingPane has two master toggles: 'App Observability' (persists backend/frontend events via set_observability_enabled, surfaces Open App Log button + log path / size / rotation count) and 'DevTools' (persists via set_devtools_enabled, surfaces an 'Open DevTools' button that calls openMainDevtools and is disabled until devtoolsEnabled is true). Both toggles persist to ui-config.json and survive across sessions. TabContextMenu's per-session observability submenu (Open Session Data / Open Tap Log / Open Observability Log) renders only when observabilityEnabled is true (props the flag through from useRuntimeStore.observabilityInfo). The console-mirror in debugLog.forwardToConsoleRaw forwards LOG-level entries to the browser console only when observabilityEnabled is true; WARN/ERR always forward.
