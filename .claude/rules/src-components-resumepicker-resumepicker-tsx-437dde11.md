---
paths:
  - "src/components/ResumePicker/ResumePicker.tsx"
---

# src/components/ResumePicker/ResumePicker.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-03 L92] Ctrl+Shift+R opens resume picker (browse past Claude sessions); 660px modal, 520px list max-height; cards show blue top-bar + tint when Ctrl is held; resume banner uses orange accent (not blue)
- [SL-05 L208] Chain merging: sessions linked by parentId (resolved via sourceToolAssistantUUID -> message UUID map in Rust) merged into a single card; latest session used for resume, names resolved from any member, suppressed plan-mode artifact messages skipped, sizes summed; stacked box-shadow when chainLength > 1; clickable chain count badge expands to show individual members for resuming older sessions
- [SL-06 L249] Custom names: tab renames persist in `sessionNames` map (localStorage); shown as bold primary name with directory as secondary text in resume picker
- [SL-04 L259] Resume picker enriched data: each session card shows firstMessage, lastMessage (from tail scan), settings badges (model, skip-perms, permission mode, effort, agent), and file size

## Session Resume

- [SR-07 L134] Content search: typing 3+ chars in the filter bar triggers a debounced (400ms) Rust backend scan of all conversation JSONL files, matching user and assistant messages. Results appear below metadata matches with a blue left border and snippet. Stale results discarded via counter-based ref.
