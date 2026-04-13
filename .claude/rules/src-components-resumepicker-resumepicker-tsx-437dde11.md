---
paths:
  - "src/components/ResumePicker/ResumePicker.tsx"
---

# src/components/ResumePicker/ResumePicker.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-05 L207] Chain merging: sessions linked by parentId (resolved via sourceToolAssistantUUID -> message UUID map in Rust) merged into a single card; latest session used for resume, names resolved from any member, suppressed plan-mode artifact messages skipped, sizes summed; stacked box-shadow when chainLength > 1; clickable chain count badge expands to show individual members for resuming older sessions

## Session Resume

- [SR-07 L133] Content search: typing 3+ chars in the filter bar triggers a debounced (400ms) Rust backend scan of all conversation JSONL files, matching user and assistant messages. Results appear below metadata matches with a blue left border and snippet. Stale results discarded via counter-based ref.
