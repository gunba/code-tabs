---
paths:
  - "src/components/Terminal/**"
  - "src/hooks/useTerminal.ts"
---

# Terminal

<!-- Codes: TR=Terminal -->

- [TR-01] Scroll-to-top button appears at top-right when scrolled down; scroll-to-bottom button at bottom-right when scrolled up
- [TR-02] Per-session token badge: shown on the tab card (top-right, absolutely positioned, hidden on hover to make room for action buttons) showing session token count; tooltip shows input/output breakdown; hidden when dead or zero tokens
- [TR-03] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom
- [TR-05] Hidden tabs use CSS `display: none` — never unmount/remount xterm.js (destroys state)
- [TR-06] Fixed 1M scrollback buffer — no dynamic resizing
- [TR-07] Vertical button bar (28px): right-side column with scroll-to-top, scroll-to-last-message, queue input, and scroll-to-bottom. Conditionally rendered when visible and not dead; individual scroll buttons within use visibility toggling.
  - Files: src/components/Terminal/TerminalPanel.tsx
- [TR-08] Scroll to last user message: uses xterm.js buffer markers registered on user Enter presses (not prompt scanning), accessible via button bar and Ctrl+middle-click on terminal (capture phase listener)
  - Files: src/hooks/useTerminal.ts, src/components/Terminal/TerminalPanel.tsx
- [TR-09] Ctrl+wheel snaps to top/bottom; requires zoomHotkeysEnabled: false in tauri.conf.json to prevent WebView2 zoom interception
  - Files: src/components/Terminal/TerminalPanel.tsx, src-tauri/tauri.conf.json
- [TR-10] fit() deferred on tab switch via double requestAnimationFrame -- waits for browser layout reflow before sizing, prevents tiny-terminal bug. Cancels on rapid tab switching.
  - Files: src/components/Terminal/TerminalPanel.tsx
- [TR-11] Subagent card shows selected highlight (accent-secondary left border + tinted background) when its inspector is open.
  - Files: src/App.tsx, src/App.css
- [TR-12] Tool blocks in SubagentInspector are collapsible: collapsed by default with tool name + one-line preview, click to expand. Last tool block auto-expands while subagent is active.
  - Files: src/components/SubagentInspector/SubagentInspector.tsx, src/components/SubagentInspector/SubagentInspector.css
- [TR-13] Context clear detection: terminal scrollback auto-clears when Claude session ID changes (/clear, plan approval, compaction). Signal-based via inspector — no input parsing or timers.
  - Files: src/components/Terminal/TerminalPanel.tsx
- [TR-14] Scroll position preservation: full-redraw sync blocks conditionally clear scrollback (ESC[3J only when content exceeds terminal height), preserving scroll position for redraws that fit the viewport. ESC[2J is replaced with ESC[H ESC[J. Frontend `flushWrites` detects scrollback clear (baseY shrinkage) and scrolls to bottom, or restores absolute viewport position if moved unexpectedly. Tab switches use `useLayoutEffect` + `visibility:hidden` for flicker-free buffer flush.
  - Files: src-tauri/pty-patch/src/lib.rs, src/hooks/useTerminal.ts, src/components/Terminal/TerminalPanel.tsx
