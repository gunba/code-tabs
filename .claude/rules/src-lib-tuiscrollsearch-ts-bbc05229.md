---
paths:
  - "src/lib/tuiScrollSearch.ts"
---

# src/lib/tuiScrollSearch.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Terminal UI

- [TA-11 L5] scrollTuiToText (tuiScrollSearch.ts) no longer calls navigateToResult from a useEffect on activeIndex (caused double-navigate). New helpers: normalizeTargets(text|string[]) strips ANSI escapes and normalizes whitespace; viewportIncludesTarget checks current viewport against all normalized targets; scrollToTuiEdge drives the terminal to the bottom (or top) by sending PAGE_DOWN/PAGE_UP until viewport stops changing (edge detection by string equality) or a target is found — ensures the search loop always terminates.
