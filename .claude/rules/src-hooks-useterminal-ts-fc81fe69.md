---
paths:
  - "src/hooks/useTerminal.ts"
---

# src/hooks/useTerminal.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Keyboard Shortcuts

- [KB-10 L300] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts

## Terminal Scroll

- [TR-03 L290,295] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom. Handled in useTerminal's attachCustomKeyEventHandler.

## PTY Output

- [PT-06 L166] Fixed 1M scrollback buffer in useTerminal -- no dynamic resizing. Set via scrollback option on Terminal constructor.
- [PT-16 L469] PTY output stays raw through pty_read -> Uint8Array -> useTerminal.writeBytes -> term.write(). The frontend logs exact chunk content plus before/after xterm buffer state, and perf spans measure the write callback latency.
- [PT-08 L578] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/isAtTop use 2-line BOTTOM_TOLERANCE for near-bottom snap.

## Data Flow

- [DF-06 L110] useTerminal attempts the WebglAddon once when the terminal opens. If WebGL creation fails or the context is later lost, the hook logs the event, disposes the addon, and lets xterm continue on the canvas renderer; there is no retry loop.
- [DF-05 L167] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-03 L469] useTerminal.writeBytes writes raw PTY Uint8Array chunks directly to xterm.js term.write(), with observability logging before and after the write callback and perf spans around the apply latency. The current app has no hidden-tab PTY buffering or deferred redraw path in this write flow.
