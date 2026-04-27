---
paths:
  - "src/components/ContextViewer/ContextViewer.tsx"
---

# src/components/ContextViewer/ContextViewer.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Terminal UI

- [TA-04 L1] ContextViewer modal ('Context' StatusBar button, no keyboard shortcut): shows captured context as a unified main-agent timeline plus per-subagent tabs. The main tab interleaves system prompt blocks and messages, hides Agent tool_use/tool_result blocks, preserves the cache boundary marker and contextDebug token stats, and falls back to a single unstructured system block when needed. Subagent tabs derive from Agent tool_use input.description/prompt and pair results by tool_use id. Includes per-entry expand/collapse plus current-tab Expand All. Opens via onOpenContextViewer in StatusBar/App and is dismissed via Escape. For Codex sessions, messages are loaded async via the read_codex_session_messages Tauri command (live read of the rollout JSONL on demand) instead of metadata.capturedMessages; the useCodexMessages hook refreshes on CodexTaskComplete and UserInterruption tap events. Codex-specific block renderers: 'reasoning' chip (no plaintext — encrypted_content opaque) and 'compaction_summary' divider. Compaction boundaries are emitted by buildMainTabEntries when a system message containing only a compaction_summary block is detected; messages prior to the latest compaction render with .context-message-pre-compaction (opacity 0.55).
