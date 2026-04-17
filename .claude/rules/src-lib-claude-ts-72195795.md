---
paths:
  - "src/lib/claude.ts"
---

# src/lib/claude.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Command Bar

- [CB-12 L254] Heat gradient expanded to 5-tier WoW rarity scale (heat-0 through heat-4): uncommon (green), rare (blue), epic (purple), legendary (orange). computeHeatLevel() in claude.ts uses thresholds 0.20, 0.50, 0.80. CSS classes use color-mix() with rarity CSS variables (--rarity-uncommon/rare/epic/legendary) defined in theme.ts. Replaces previous 4-tier inline-style heat system.
- [CB-10 L264] Heat gradient uses CSS classes (heat-1..heat-4). heatClassName()/computeHeatLevel() return class/level (0-4).

## Respawn & Resume

- [RS-02 L14] Resume target chain: `resumeSession || sessionId || id` (chains through multiple respawns)
- [RS-03 L20] Check conversation existence via resumeSession || nodeSummary || assistantMessageCount > 0 (in-memory, no JSONL). canResumeSession() in claude.ts returns true when any of these three conditions holds: config.resumeSession is set, metadata.nodeSummary is present, or metadata.assistantMessageCount > 0.

## Dead Session Handling

- [DS-03 L19] Auto-resume guarded by `canResumeSession()` (derived from `sessionId`, `resumeSession`, or `nodeSummary` — no JSONL check)

## Session Resume

- [SR-08 L40] Worktree flag stripping on resume: `-w` and `--worktree` flags are stripped from extraFlags via `stripWorktreeFlags()` when resuming or respawning a session. Prevents creating a duplicate worktree — the session resumes in the existing worktree directory (workingDir was updated by inspector cwd detection [SI-20]).

## Terminal UI

- [TA-01 L123] Tab activity display: getActivityText() prioritizes currentEventKind (raw TAP event identifiers like ToolCallStart, ThinkingStart) over currentToolName. EVENT_KIND_COLORS map and eventKindColor() provide phase-based coloring (tool lifecycle=purple, thinking=purple, text=yellow, turn=green, permissions=peach/green/pink, errors=red). TOOL_COLORS + toolCategoryColor() used as fallback. tapMetadataAccumulator uses minimal block list (ApiTelemetry, ProcessHealth, ApiFetch excluded). App.tsx renders .tab-activity span with eventKindColor; unknown events fall back to --text-muted.
