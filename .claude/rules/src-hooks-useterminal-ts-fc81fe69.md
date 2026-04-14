---
paths:
  - "src/hooks/useTerminal.ts"
---

# src/hooks/useTerminal.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Keyboard Shortcuts

- [KB-12 L189] Platform-gated paste blocker: a capture-phase paste event listener calling preventDefault is installed on the xterm DOM element only when IS_WINDOWS is true. This prevents the Tauri permission dialog from causing a double-paste (Tauri synthesizes a paste event on top of the custom Ctrl+V handler). Non-Windows platforms rely on xterm.js native paste handling. Ctrl+Shift+V and Ctrl+V paste handlers are cross-platform and always active.
- [KB-10 L407] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts

## Terminal Scroll

- [TR-03 L397,402] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom. Handled in useTerminal's attachCustomKeyEventHandler.

## PTY Output

- [PT-06 L225] Fixed 1M scrollback buffer in useTerminal -- no dynamic resizing. Set via scrollback option on Terminal constructor.
- [PT-16 L582] PTY output stays raw through pty_read -> Uint8Array -> useTerminal.writeBytes -> term.write(). The frontend logs exact chunk content plus before/after xterm buffer state, and perf spans measure the write callback latency.
- [PT-08 L691] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/isAtTop use 2-line BOTTOM_TOLERANCE for near-bottom snap.

## Data Flow

- [DF-10 L74] useTerminal.fit() calls FitAddon.fit() without a surrounding try/catch, so resize errors propagate to the caller rather than being silently swallowed. The outer traceSync wrapper still captures timing; exceptions escape it normally.
- [DF-06 L117] useTerminal attempts the WebglAddon once when the terminal opens. If WebGL creation fails or the context is later lost, the hook logs the event, disposes the addon, and lets xterm continue on the canvas renderer; there is no retry loop.
- [DF-11 L142] Xterm addons loaded on terminal open: SearchAddon, WebLinksAddon, and Unicode11Addon are each loaded via try/catch in openTerminal() immediately after WebglAddon. Unicode11Addon sets term.unicode.activeVersion = '11' after loadAddon. All three are disposed in the cleanup effect alongside WebglAddon. No keybind wiring for search — SearchPanel is the primary search UI; the SearchAddon is loaded for potential future use or programmatic calls.
- [DF-05 L226] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-03 L582] useTerminal.writeBytes writes raw PTY Uint8Array chunks directly to xterm.js term.write(), with observability logging before and after the write callback and perf spans around the apply latency. The current app has no hidden-tab PTY buffering or deferred redraw path in this write flow.

## Terminal UI

- [TA-10 L303] Auto-rename from OSC 0: term.onTitleChange fires when Claude Code's Haiku subagent emits a title via OSC 0 (Linux/macOS). The handler trims the raw title, guards on sid/title/non-app-name, then calls renameSession(sid, title) and setSessionName(getResumeId(session), title) — the same dual write as the CustomTitle TAP event handler. Windows Claude Code sets process.title instead and does not fire OSC 0, so onTitleChange is a no-op on Windows.
