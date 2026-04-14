---
paths:
  - "src/components/Terminal/TerminalPanel.css"
---

# src/components/Terminal/TerminalPanel.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## PTY Output

- [PT-08 L47] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/isAtTop use 2-line BOTTOM_TOLERANCE for near-bottom snap.

## Session Resume

- [SR-06 L33] Loading spinner @keyframes spin rule defined in TerminalPanel.css — animates border-top rotation at 0.8s linear infinite
