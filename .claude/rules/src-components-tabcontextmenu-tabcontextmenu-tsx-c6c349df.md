---
paths:
  - "src/components/TabContextMenu/TabContextMenu.tsx"
---

# src/components/TabContextMenu/TabContextMenu.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-24 L99] Fork into New Tab is available from resumable live/dead tabs and resume-history rows, and creates a separate session immediately instead of replacing or resuming the current tab.
  - App.tsx tab context-menu handler builds a fork config with buildForkSessionConfig(), loading past sessions first when a live tab lacks a captured session id. ResumePicker right-click Fork into New Tab uses buildForkConfigFromPastSession(). Both add the fork workingDir to recents, createSession with a Fork-suffixed name, and leave ordinary resume/configure paths with forkSession false.
