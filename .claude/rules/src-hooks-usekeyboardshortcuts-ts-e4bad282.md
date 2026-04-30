---
paths:
  - "src/hooks/useKeyboardShortcuts.ts"
---

# src/hooks/useKeyboardShortcuts.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Keyboard Shortcuts

- [KB-01 L84] Ctrl+T — New session
- [KB-02 L93] Ctrl+W — Close active tab
- [KB-06 L99] Ctrl+K — Command palette
- [KB-03 L105] Ctrl+Shift+R -- Resume from history
- [KB-11 L111] Ctrl+Shift+F — Open cross-session terminal search panel (side panel). Escape closes the panel.
- [KB-07 L117] Ctrl+, — Open Config Manager
- [KB-09 L132] Escape handling in useKeyboardShortcuts unwinds transient UI before sending ESC to the terminal, in this order: close tab context menu; if the command palette is open, return and let the palette own Escape; close changelog request; close ContextViewer; dispatch CONFIG_MANAGER_CLOSE_REQUEST_EVENT for ConfigManager; close ResumePicker; close SessionLauncher; clear inspectedSubagent; blur any focused non-xterm element and refocus the active terminal on the next animation frame; otherwise write \x1b to the active PTY.
- [KB-04 L155] Ctrl+Tab / Ctrl+Shift+Tab — Cycle tabs
- [KB-05 L162] Alt+1-9 — Jump to tab N

## Session Launcher

- [SL-02 L81] Quick launch: Ctrl+Click + or Ctrl+Shift+T launches without the modal using saved defaults or lastConfig, after clearing resumeSession, forkSession, continueSession, sessionId, and runMode.
  - quickLaunchSession() strips transient one-shot fields before createSession; App.tsx Ctrl+Shift+T delegates to this path.
- [SL-01 L84] SessionLauncher opens for new, resume, or fork launches; Ctrl+T opens a fresh launcher and clears resumeSession, forkSession, and continueSession from lastConfig.
  - SessionLauncher renders Fork Session/Forking from when config.resumeSession && config.forkSession. The Ctrl+T global shortcut strips all one-shot resume/fork/continue fields before showing the modal.
