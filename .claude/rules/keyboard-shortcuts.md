---
paths:
  - "src/App.tsx"
  - "src/hooks/useTerminal.ts"
---

# Keyboard Shortcuts

<!-- Codes: KB=Keyboard Shortcuts -->

- [KB-01] Ctrl+T — New session
- [KB-02] Ctrl+W — Close active tab
- [KB-03] Ctrl+Shift+R -- Resume from history
  - Files: src/App.tsx
- [KB-04] Ctrl+Tab / Ctrl+Shift+Tab — Cycle tabs
- [KB-05] Alt+1-9 — Jump to tab N
- [KB-06] Ctrl+K — Command palette
- [KB-07] Ctrl+, — Open Config Manager
- [KB-09] Esc — Close modal / dismiss inspector (ordered: contextMenu -> palette -> contextMeterTarget -> sidePanel(debug|diff) -> config -> resume -> launcher -> inspector). DiffModal intercepts Escape via stopPropagation wrapper so closing the modal does not close the sidebar.
- [KB-10] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts
  - Files: src/hooks/useTerminal.ts
