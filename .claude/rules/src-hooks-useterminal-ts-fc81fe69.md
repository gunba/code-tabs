---
paths:
  - "src/hooks/useTerminal.ts"
---

# src/hooks/useTerminal.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Keyboard Shortcuts

- [KB-12 L257] Platform-gated paste blocker: capture-phase paste event listener calling preventDefault is installed on the xterm DOM element when IS_WINDOWS or IS_LINUX is true (extended from Windows-only). Windows: prevents Tauri permission-dialog double-paste. Linux: lets Ctrl+V send ^V to PTY so Claude Code runs its native wl-paste/xclip clipboard read for text and image paste. macOS left alone. Ctrl+Shift+V is cross-platform paste via clipboard.readText(). Ctrl+V on Linux returns true (passes to PTY as ^V) rather than reading clipboard directly.
- [KB-10 L509] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts

## Terminal Scroll

- [TR-03 L499,504] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom. Handled in useTerminal's attachCustomKeyEventHandler.

## PTY Output

- [PT-06 L299] Fixed 1M scrollback buffer in useTerminal -- no dynamic resizing. Set via scrollback option on Terminal constructor.
- [PT-16 L754] PTY output flows pty_read (Tauri) -> Uint8Array chunks -> useTerminal.writeBytes -> TerminalWriteQueue (enqueueTerminalWrite) -> flushWriteQueue -> term.write(batch.data). Hidden tabs (visibleRef.current=false) keep chunks queued; useEffect on visible flips drains the queue. Adjacent Uint8Array chunks merge up to 256KB before a single term.write call. Decoding to text is deferred until a debug log/perf span needs it (terminalOutputDecoder shared at module scope).
- [PT-08 L840] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/isAtTop use 2-line BOTTOM_TOLERANCE for near-bottom snap.

## Data Flow

- [DF-05 L29] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-10 L124] useTerminal.fit() calls FitAddon.fit() without a surrounding try/catch, so resize errors propagate to the caller rather than being silently swallowed. The outer traceSync wrapper still captures timing; exceptions escape it normally.
- [DF-06 L168] useTerminal creates the WebglAddon once on openTerminal when enableWebgl=true and keeps it alive for the terminal's lifetime (no longer torn down on tab hide). onContextLoss disposes the addon and falls back to the canvas renderer with no retry loop. cursorBlink is still flipped on visibility to avoid wasted draws while hidden.
- [DF-11 L199] Xterm addons loaded on terminal open (openTerminal): WebLinksAddon, pathLinkProvider, and Unicode11Addon loaded via try/catch after WebglAddon. WebLinksAddon takes a custom click handler: plain click invokes Tauri 'shell_open'; Ctrl/Cmd+click invokes 'reveal_in_file_manager'. Unicode11Addon sets term.unicode.activeVersion='11'. All three addons plus pathLinkDisposable are disposed in cleanup. SearchAddon was removed in 32af768 along with the @xterm/addon-search dependency; no in-terminal search UI is wired today. pathLinkProvider (src/lib/terminalPathLinks.ts) is a separate ILinkProvider registered via term.registerLinkProvider().
- [DF-03 L754] useTerminal.write/writeBytes enqueue text or Uint8Array chunks into a per-terminal TerminalWriteQueue (createTerminalWriteQueue) and call flushWriteQueue. flushWriteQueue is gated on visibleRef.current — hidden tabs keep raw output queued and xterm parsing/rendering catches up on activation. When visible and not in-flight, it pulls a batched chunk via takeTerminalWriteBatch (merges adjacent same-type chunks up to 256KB / 256K chars), passes batch.data to term.write with a callback that re-fires flushWriteQueue. writeInFlightRef serializes consecutive batches; visibility flips trigger flush via useEffect. Decoded text is computed lazily (terminalOutputDecoder, module-scoped) only when DEBUG capture is enabled. perf spans + dlog calls share the same shouldRecordDebugLog gate.

## Terminal UI

- [TA-12 L31] getTerminalKeySequenceOverride (useTerminal.ts): intercepts Shift+Enter (keydown, key='Enter', shiftKey=true, no Ctrl/Alt/Meta) and returns kitty-protocol sequence \x1b[13;2u (SHIFT_ENTER_SEQUENCE constant). The xterm.js custom key handler calls onData with the sequence and returns false to prevent xterm's default Enter handling. Allows Claude Code to distinguish Shift+Enter from bare Enter for multi-line input.
- [TA-10 L384] Auto-rename from OSC 0: term.onTitleChange fires when Claude Code's Haiku subagent emits a title via OSC 0 (Linux/macOS). Handler strips leading non-letter/digit chars (spinners, bullets) via Unicode property escape regex, then skips if title is empty, equals 'Claude Tabs', starts with 'Claude Code', or equals 'claude' (case-insensitive) — the last guard added to prevent bare 'claude' resume title from clobbering Haiku-generated session name (commit 023bb4a). On valid title, calls renameSession(sid, title) and setSessionName(getResumeId(session), title). Windows uses process.title and does not fire OSC 0. source: src/hooks/useTerminal.ts:L336
