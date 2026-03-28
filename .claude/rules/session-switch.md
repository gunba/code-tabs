---
paths:
  - "src/hooks/useInspectorConnection.ts"
---

# Session Switch

<!-- Codes: SS=Session Switch -->

- [SS-01] Inspector detects session switches (plan-mode fork, `/resume`, compaction) via `sid` field change
- [SS-02] Same Bun process, same WebSocket — inspector automatically tracks the new session
- [SS-03] No JSONL file scanning or polling required
