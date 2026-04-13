---
paths:
  - "src/lib/terminalRegistry.ts"
---

# src/lib/terminalRegistry.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Terminal UI

- [TR-16 L1] Cross-session search panel (Ctrl+Shift+F): SearchPanel searches active session JSONL conversation files via invoke('search_jsonl_files') Rust command. Debounced queries (250ms). Case-sensitive and regex modes. Results grouped by session; clicking a result switches tab and scrolls to match via scrollTuiToText (TUI scroll search). Capped at 500 results. searchBuffers.ts provides validateRegex for client-side regex validation; terminalRegistry.ts manages terminal focus and buffer readers but not SearchAddon.
