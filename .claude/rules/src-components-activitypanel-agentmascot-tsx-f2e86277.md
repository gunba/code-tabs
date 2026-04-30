---
paths:
  - "src/components/ActivityPanel/AgentMascot.tsx"
---

# src/components/ActivityPanel/AgentMascot.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Panel

- [AP-04 L37] ActivityPanel shows a floating/sticky mascot that travels to the file currently being accessed by the main agent. The mascot is provider-aware (cli prop drives MASCOT_SRC: claude-mascot.png or codex-mascot.png — pre-rename agent-mascot.png is gone). Animations: reading (rocking), writing (rocking), moving (hop on path change), idle (subtle bob). Mascot animation is suppressed on tab switch: StickyMascot carries a tabId, and the floating mascot div is only rendered when mascot.tabId === activeTabId. On tab switch the stale mascot unmounts, preventing the CSS transition from animating the jump between tabs; the effect re-runs on activeTabId change and mounts a fresh mascot at the new tab's position. Mascot persists within a session across idle periods. Subagent files show inline indicators at their last-touched files while active, and completed subagents remain dimmed at their last-touched files. Subagent indicators render <AgentTypeIcon> (Compass / Clipboard / Sparkles / BookOpen / Terminal / ShieldCheck / Bot fallback) inside the same .agent-mascot-img wrapper so the rock/hop/bob animations and overlay emoji apply identically; only main-agent indicators use the provider mascot artwork. .agent-mascot-icon tints the SVG with var(--cli-claude). Tree indentation uses INDENT_STEP=16px.
