---
paths:
  - "src/components/Terminal/TerminalPanel.tsx"
---

# src/components/Terminal/TerminalPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Terminal UI

- [TA-13 L32] TerminalPanel is wrapped in React.memo with terminalPanelPropsEqual comparing prev/next on visible, session.id, session.state, session.name, session.config (reference), session.metadata.nodeSummary, and session.metadata.assistantMessageCount. Other Session metadata fields don't trigger a re-render — TerminalPanel only depends on these for its rendered output. Prevents tap-event-driven metadata churn from re-rendering the heavy terminal subtree.
  - src/components/Terminal/TerminalPanel.tsx:L29 (terminalPanelPropsEqual); src/components/Terminal/TerminalPanel.tsx:L106 (memo wrap); src/components/Terminal/TerminalPanel.tsx:L762 (export memo with comparator).
- [TR-05 L201] Hidden tabs use CSS display: none -- never unmount/remount xterm.js (destroys state).
