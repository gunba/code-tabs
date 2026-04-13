---
paths:
  - "src/components/SubagentInspector/SubagentInspector.tsx"
---

# src/components/SubagentInspector/SubagentInspector.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Inspector Tap Pipeline

- [IN-08 L112] SubagentInspector tool block collapse: MessageBlock is wrapped in React.memo to avoid re-rendering unchanged messages; collapsed fallback previews use the first non-empty line with visual truncation handled by CSS ellipsis instead of a 120-character slice. Parent computes lastToolIndex via reduce, and only the last tool message auto-expands while the subagent is active (not dead or idle). React key={i} keeps mounts stable.

## Terminal UI

- [TR-12 L112] Tool blocks in SubagentInspector: when structured toolInput is available on a message, tool-specific renderers are used — EditRenderer shows inline diff with file header and +/- line counts, BashRenderer shows a $ prompt with command text, FileToolRenderer (Read/Write) shows a file header, SearchRenderer (Grep/Glob) shows pattern and optional path. All use the shared FileHeader component. Fallback for messages without toolInput: collapsible block (collapsed by default) with tool name + one-line preview, click to expand. MessageBlock wrapped in React.memo with msg-reference equality. Last tool block auto-expands while subagent is active.
- [TA-08 L236] Completed subagents stay visible in the subagent bar with a success checkmark (✓ character, no animation) and full opacity. Green bottom border (box-shadow) and check-pop animation removed — .subagent-completed only sets opacity:1. SubagentInspector renders terminal-style Prompt, Conversation, Result, and pending sections for retained subagent runs.
