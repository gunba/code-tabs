---
paths:
  - "src/App.tsx"
---

# src/App.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-02 L137,247] Quick launch: Ctrl+Click "+" or Ctrl+Shift+T instantly launches without showing modal; uses saved defaults if set, otherwise falls back to last-used config (including folder)
- [SL-01 L250] Modal for new session or resume — Ctrl+T opens fresh (clears resume/continue flags)

## Keyboard Shortcuts

- [KB-01 L250] Ctrl+T — New session
- [KB-02 L259] Ctrl+W — Close active tab
- [KB-06 L265] Ctrl+K — Command palette
- [KB-03 L271] Ctrl+Shift+R -- Resume from history
- [KB-07 L284] Ctrl+, — Open Config Manager
- [KB-09 L295] Esc — Close modal / dismiss inspector (ordered: contextMenu -> palette -> sidePanel(debug|activity|search) -> contextViewer -> config -> resume -> launcher -> inspector). SearchPanel intercepts Escape so closing the panel does not fall through to terminal input.
- [KB-04 L316] Ctrl+Tab / Ctrl+Shift+Tab — Cycle tabs
- [KB-05 L329] Alt+1-9 — Jump to tab N

## Persistence

- [PS-03 L158] Debounced auto-persist every 2s on session array changes
- [PS-02 L166] `beforeunload` event flushes sessions so they survive app restart
- [PS-04 L166] `beforeunload` kills all active PTY process trees before persisting — prevents orphaned CLI processes holding session locks on restart

## Respawn & Resume

- [RS-04 L145] `resumeSession` and `continueSession` are one-shot flags — never persist in `lastConfig`

## Hooks Manager

- [HM-11 L117] Hook configuration is user-managed only: claude-tabs may read and edit existing Claude hook files via the Hooks UI, but it never auto-installs or mutates user hook settings on startup.

## State Metadata

- [SI-25 L401] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.

## Dead Session Handling

- [DS-05 L272] Ctrl+Shift+R opens resume picker from any state; ResumePicker detects active dead tabs via deadSessionMap and resumes them by calling createSession with the dead tab's config (resumeSession set to the original session ID)

## Data Flow

- [DF-04 L41] React re-renders from Zustand store: tab state dots, status bar, subagent cards

## Terminal UI

- [TA-01 L380] Tab activity display: getActivityText() prioritizes currentEventKind (raw TAP event identifiers like ToolCallStart, ThinkingStart) over currentToolName. EVENT_KIND_COLORS map and eventKindColor() provide phase-based coloring (tool lifecycle=purple, thinking=purple, text=yellow, turn=green, permissions=peach/green/pink, errors=red). TOOL_COLORS + toolCategoryColor() used as fallback. tapMetadataAccumulator uses minimal block list (ApiTelemetry, ProcessHealth, ApiFetch excluded). App.tsx renders .tab-activity span with eventKindColor; unknown events fall back to --text-muted.
- [TA-06 L598] Subagent activity display: subagent cards in the subagent bar use the same getActivityText() + eventKindColor() pattern as parent session tabs for showing real-time tool activity. Replaces truncated last-message text with phase-colored event kind display. Uses tab-activity CSS class for consistent styling.
- [TA-09 L604] Subagent card meta row falls back to parent session effectiveModel when sub.model is absent: displays modelLabel() + version extracted from model string.
- [TA-08 L615] Completed subagents stay visible in the subagent bar with a success checkmark (✓ character, no animation) and full opacity. Green bottom border (box-shadow) and check-pop animation removed — .subagent-completed only sets opacity:1. SubagentInspector renders terminal-style Prompt, Conversation, Result, and pending sections for retained subagent runs.
- [TR-11 L616] Subagent card shows selected highlight (accent-secondary box-shadow + tinted background) when its inspector is open.
