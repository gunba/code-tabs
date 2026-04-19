---
paths:
  - "src/hooks/useTerminal.ts"
---

# src/hooks/useTerminal.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Keyboard Shortcuts

- [KB-12 L222] Platform-gated paste blocker: capture-phase paste event listener calling preventDefault is installed on the xterm DOM element when IS_WINDOWS or IS_LINUX is true (extended from Windows-only). Windows: prevents Tauri permission-dialog double-paste. Linux: lets Ctrl+V send ^V to PTY so Claude Code runs its native wl-paste/xclip clipboard read for text and image paste. macOS left alone. Ctrl+Shift+V is cross-platform paste via clipboard.readText(). Ctrl+V on Linux returns true (passes to PTY as ^V) rather than reading clipboard directly.
- [KB-10 L447] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts

## Terminal Scroll

- [TR-03 L437,442] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom. Handled in useTerminal's attachCustomKeyEventHandler.

## PTY Output

- [PT-06 L258] Fixed 1M scrollback buffer in useTerminal -- no dynamic resizing. Set via scrollback option on Terminal constructor.
- [PT-16 L624] PTY output stays raw through pty_read -> Uint8Array -> useTerminal.writeBytes -> term.write(). The frontend logs exact chunk content plus before/after xterm buffer state, and perf spans measure the write callback latency.
- [PT-08 L733] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/isAtTop use 2-line BOTTOM_TOLERANCE for near-bottom snap.

## Data Flow

- [DF-10 L81] useTerminal.fit() calls FitAddon.fit() without a surrounding try/catch, so resize errors propagate to the caller rather than being silently swallowed. The outer traceSync wrapper still captures timing; exceptions escape it normally.
- [DF-06 L124] useTerminal attempts the WebglAddon once when the terminal opens. If WebGL creation fails or the context is later lost, the hook logs the event, disposes the addon, and lets xterm continue on the canvas renderer; there is no retry loop.
- [DF-11 L149] Xterm addons loaded on terminal open (openTerminal): SearchAddon, WebLinksAddon, pathLinkProvider, and Unicode11Addon loaded via try/catch after WebglAddon. WebLinksAddon takes a custom click handler: plain click invokes Tauri 'shell_open'; Ctrl/Cmd+click invokes 'reveal_in_file_manager'. Unicode11Addon sets term.unicode.activeVersion='11'. All three addons plus pathLinkDisposable are disposed in cleanup. No keybind wiring for search. pathLinkProvider (src/lib/terminalPathLinks.ts) is a separate ILinkProvider registered via term.registerLinkProvider().
- [DF-05 L259] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-03 L624] useTerminal.writeBytes writes raw PTY Uint8Array chunks directly to xterm.js term.write(), with observability logging before and after the write callback and perf spans around the apply latency. The current app has no hidden-tab PTY buffering or deferred redraw path in this write flow.

## Terminal UI

- [TA-10 L336] Auto-rename from OSC 0: term.onTitleChange fires when Claude Code's Haiku subagent emits a title via OSC 0 (Linux/macOS). Handler strips leading non-letter/digit chars (spinners, bullets) via Unicode property escape regex, then skips if title is empty, equals 'Claude Tabs', or starts with 'Claude Code' (default placeholder). On valid title, calls renameSession(sid, title) and setSessionName(getResumeId(session), title) — same dual write as CustomTitle TAP event. Windows uses process.title and does not fire OSC 0.
