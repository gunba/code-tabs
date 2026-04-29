---
paths:
  - "src/hooks/useXtermLifecycle.ts"
---

# src/hooks/useXtermLifecycle.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Keyboard Shortcuts

- [KB-12 L202] Platform-gated paste blocker: capture-phase paste event listener calling preventDefault is installed on the xterm DOM element when IS_WINDOWS or IS_LINUX is true (extended from Windows-only). Windows: prevents Tauri permission-dialog double-paste. Linux: lets Ctrl+V send ^V to PTY so Claude Code runs its native wl-paste/xclip clipboard read for text and image paste. macOS left alone. Ctrl+Shift+V is cross-platform paste via clipboard.readText(). Ctrl+V on Linux returns true (passes to PTY as ^V) rather than reading clipboard directly.

## PTY Output

- [PT-06 L244] Fixed 1M scrollback buffer in useTerminal -- no dynamic resizing. Set via scrollback option on Terminal constructor.

## Data Flow

- [DF-10 L69] useTerminal.fit() calls FitAddon.fit() without a surrounding try/catch, so resize errors propagate to the caller rather than being silently swallowed. The outer traceSync wrapper still captures timing; exceptions escape it normally.
- [DF-06 L113] useTerminal creates the WebglAddon once on openTerminal when enableWebgl=true and keeps it alive for the terminal's lifetime (no longer torn down on tab hide). onContextLoss disposes the addon and falls back to the canvas renderer with no retry loop. cursorBlink is still flipped on visibility to avoid wasted draws while hidden.
- [DF-11 L144] Xterm addons loaded on terminal open (openTerminal): WebLinksAddon, pathLinkProvider, and Unicode11Addon loaded via try/catch after WebglAddon. WebLinksAddon takes a custom click handler: plain click invokes Tauri 'shell_open'; Ctrl/Cmd+click invokes 'reveal_in_file_manager'. Unicode11Addon sets term.unicode.activeVersion='11'. All three addons plus pathLinkDisposable are disposed in cleanup. SearchAddon was removed in 32af768 along with the @xterm/addon-search dependency; no in-terminal search UI is wired today. pathLinkProvider (src/lib/terminalPathLinks.ts) is a separate ILinkProvider registered via term.registerLinkProvider().

## Terminal UI

- [TA-10 L329] Auto-rename from OSC 0: term.onTitleChange fires when Claude Code's Haiku subagent emits a title via OSC 0 (Linux/macOS). Handler strips leading non-letter/digit chars (spinners, bullets) via Unicode property escape regex, then skips if title is empty, equals 'Claude Tabs', starts with 'Claude Code', or equals 'claude' (case-insensitive) — the last guard added to prevent bare 'claude' resume title from clobbering Haiku-generated session name (commit 023bb4a). On valid title, calls renameSession(sid, title) and setSessionName(getResumeId(session), title). Windows uses process.title and does not fire OSC 0. source: src/hooks/useTerminal.ts:L336
