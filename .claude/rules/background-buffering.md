---
paths:
  - "src/components/Terminal/TerminalPanel.tsx"
  - "src/hooks/useTerminal.ts"
---

# Background Buffering

<!-- Codes: BF=Background Buffering -->

- [BF-01] Background tabs: PTY data buffered in bgBufferRef, flushed via useLayoutEffect on tab focus. Container hidden with opacity:0 (not visibility:hidden — keeps WebGL renderer active). Reveal deferred to xterm.js onRender event (fires after renderer paints). Write callback sets scrollToBottom, onRender handler restores opacity. For no-buffer tab switch, refresh() forces a render cycle to guarantee onRender fires. O(1) rendering cost while hidden.
- [BF-02] `visibleRef` tracks tab visibility for buffering decisions
- [BF-03] Resize occlusion: useTerminal calls onBeforeFit callback before fit() in ResizeObserver. TerminalPanel provides handleBeforeFit which sets container opacity:0 on visible tabs and arms a one-shot onRender listener to restore opacity. Prevents content reflow snap when panels open/close or window resizes. Guard: only fires when visibleRef.current is true (hidden tabs skip).
  - Files: src/hooks/useTerminal.ts, src/components/Terminal/TerminalPanel.tsx
