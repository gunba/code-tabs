---
paths:
  - "src/App.tsx"
---

# src/App.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Keyboard Shortcuts

- [KB-01 L318] Ctrl+T — New session
- [KB-02 L327] Ctrl+W — Close active tab
- [KB-06 L333] Ctrl+K — Command palette
- [KB-03 L339] Ctrl+Shift+R -- Resume from history
- [KB-11 L346] Ctrl+Shift+F — Open cross-session terminal search panel (side panel). Escape closes the panel.
- [KB-07 L352] Ctrl+, — Open Config Manager
- [KB-09 L367] Esc — Close modal / dismiss inspector (ordered: contextMenu -> palette -> sidePanel(debug|activity|search) -> contextViewer -> config -> resume -> launcher -> inspector). SearchPanel intercepts Escape so closing the panel does not fall through to terminal input.
- [KB-04 L389] Ctrl+Tab / Ctrl+Shift+Tab — Cycle tabs
- [KB-05 L402] Alt+1-9 — Jump to tab N

## Persistence

- [PS-03 L226] Debounced auto-persist every 2s on session array changes
- [PS-02 L234] `beforeunload` event flushes sessions so they survive app restart
- [PS-04 L234] `beforeunload` kills all active PTY process trees before persisting — prevents orphaned CLI processes holding session locks on restart

## Respawn & Resume

- [RS-04 L201] `resumeSession` and `continueSession` are one-shot flags — never persist in `lastConfig`

## Hooks Manager

- [HM-11 L127] Hook configuration is user-managed only: claude-tabs may read and edit existing Claude hook files via the Hooks UI, but it never auto-installs or mutates user hook settings on startup.

## State Metadata

- [SI-25 L485] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.

## Dead Session Handling

- [DS-05 L340] Ctrl+Shift+R opens resume picker from any state; ResumePicker detects active dead tabs via deadSessionMap and resumes them by calling createSession with the dead tab's config (resumeSession set to the original session ID)

## Platform

- [PL-01 L177] Linux custom titlebar: tauri.conf.json sets decorations:false globally. App.tsx renders the custom Header on Linux unless linux_use_native_chrome() selects native chrome; that command returns true for KDE Wayland, where App.tsx restores native decorations via setDecorations(true). default.json grants core window permissions for set-decorations plus the custom Header drag/minimize/toggle-maximize commands.
  - Confirmed by debug build console on Linux/KDE/Wayland: setDecorations(true) failed with missing core:window:allow-set-decorations before the capability was added. The fallback Header uses startDragging(), minimize(), and toggleMaximize(), so those explicit permissions are granted alongside set-decorations.

## Session Launcher

- [SL-02 L193,315] Quick launch: Ctrl+Click "+" or Ctrl+Shift+T instantly launches without showing modal; uses saved defaults if set, otherwise falls back to last-used config (including folder)
- [SL-01 L318] Modal for new session or resume — Ctrl+T opens fresh (clears resume/continue flags)

## Data Flow

- [DF-04 L48] React re-renders from Zustand store: tab state dots, status bar, subagent cards

## Terminal UI

- [TA-01 L462] Tab activity display: getActivityText() prioritizes currentEventKind (raw TAP event identifiers like ToolCallStart, ThinkingStart) over currentToolName. EVENT_KIND_COLORS map and eventKindColor() provide phase-based coloring (tool lifecycle=purple, thinking=purple, text=yellow, turn=green, permissions=peach/green/pink, errors=red). TOOL_COLORS + toolCategoryColor() used as fallback. tapMetadataAccumulator uses minimal block list (ApiTelemetry, ProcessHealth, ApiFetch excluded). App.tsx renders .tab-activity span with eventKindColor; unknown events fall back to --text-muted.
- [TA-06 L681] Subagent activity display: subagent cards in the subagent bar use the same getActivityText() + eventKindColor() pattern as parent session tabs for showing real-time tool activity. Replaces truncated last-message text with phase-colored event kind display. Uses tab-activity CSS class for consistent styling.
- [TA-08 L692] Completed subagents stay visible in the subagent bar with a success checkmark (✓ character, no animation) and full opacity. Green bottom border (box-shadow) and check-pop animation removed — .subagent-completed only sets opacity:1. SubagentInspector renders terminal-style Prompt, Conversation, Result, and pending sections for retained subagent runs.
- [TR-11 L693] Subagent card shows selected highlight (accent-secondary box-shadow + tinted background) when its inspector is open.

## Provider-scoped UI accents
App root, launcher, and config modal carry provider-scoped CSS classes (app-provider-{cli}, provider-scope-{cli}, config-modal-cli-{cli}) that remap --accent / --accent-bg / --accent-hover to the active CLI's brand palette. Each tab also has a per-tab .tab-cli-{cli} scope so inactive Codex tabs keep their teal accent and inactive Claude tabs keep clay.

- [PO-01 L425] App root receives className 'app app-provider-{activeProvider}' (claude|codex) where activeProvider mirrors the active session's config.cli (default 'claude'). SessionLauncher's launcher container adds 'provider-scope-{config.cli}'. ConfigManager's ModalOverlay adds 'config-modal-cli-{configCli}'. Per-tab .tab-cli-{cli} scope (set in App.tsx tab JSX) sets --tab-active-accent + --provider-accent/-bg/-hover from cliClaude / cliCodex constants in theme. App.css selectors .app-provider-claude/.provider-scope-claude/.config-modal-cli-claude (and codex variants) remap --accent, --accent-bg, --accent-hover to the provider palette via :root vars --provider-claude-accent / --provider-codex-accent (set by applyTheme from theme.cliClaude/cliClaudeBg + theme.accentHover; theme.cliCodex/cliCodexBg + theme.cliCodexHover).
  - src/App.tsx:L401 (app-provider class), src/App.css:L7 (provider-scope/.app-provider/.config-modal-cli rules), src/App.css:L82 (.tab.tab-cli-codex provider override), src/lib/theme.ts:L37 (cliCodexHover field), src/lib/theme.ts:L142-148 (provider CSS vars), src/components/SessionLauncher/SessionLauncher.tsx:L488 (provider-scope class), src/components/ConfigManager/ConfigManager.tsx:L345 (config-modal-cli class), index.html:L48 (root provider vars defaults)

## Project Conventions

- [LO-01 L446] Main window layout: tab bar, subagent bar, terminal, command bar (slash commands + skill pills + command history), status bar
