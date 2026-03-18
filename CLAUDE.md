# Claude Tabs — Development Guide

## What is this?

A Tauri v2 desktop app that manages multiple Claude Code CLI sessions in tabs. Rust backend + React/TypeScript frontend. No API key — uses the Claude Code CLI directly.

## Build & Test

```bash
npm run build:quick     # Release binary, no installer (~30s incremental)
npm run build:debug     # Debug binary, fastest (~10-15s incremental)
npm run tauri dev       # Dev mode with hot-reload
npm run tauri build     # Full NSIS installer (only for releases)
```

### Validation (before every commit)

```bash
npx tsc --noEmit           # Zero TypeScript errors
npm test                   # All Vitest unit tests pass (101 across 5 files)
cargo check (in src-tauri) # Zero Rust errors
```

### Manual Testing (MANDATORY)

You MUST test every change before delivering. Do NOT guess at fixes.

1. Add logging/instrumentation to observe actual behavior
2. Launch the app (`build:quick` or `tauri dev`) and reproduce the issue
3. Read test harness state (`%LOCALAPPDATA%/claude-tabs/test-state.json`)
4. Make a targeted fix based on observed evidence
5. Re-run the same reproduction to verify the fix works
6. Only then commit and deliver

**For visual issues that the test harness can't observe, take a screenshot and visually inspect.**
If the harness can't observe an issue, EXTEND IT. Never say "I can't test this."

## Architecture

```
React UI (WebView2) ←→ Tauri IPC ←→ Rust Backend ←→ ConPTY ←→ Claude Code CLI
```

```
┌──────────────────────────────────────────────────────────────┐
│ Tab Bar  [● session1 | ● session2 | + ]                      │
├──────────────────────────────────────────────────────────────┤
│ Subagent Bar  [▐ agent-task-1  12K] [▐ agent-task-2  8K]     │
├────────────────────────────────────────────┬─────────────────┤
│  Terminal (xterm.js 6.0)                   │  ActivityFeed   │
│  (active session, CSS display toggle)      │  (actions log)  │
├────────────────────────────────────────────┴─────────────────┤
│ Command Bar (slash commands)                                  │
├──────────────────────────────────────────────────────────────┤
│ StatusBar (model, cost, tokens, duration)                     │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User types in xterm.js → `onData` → PTY `write` → ConPTY → Claude stdin
2. Claude stdout → ConPTY → `tauri-pty` npm `onData` → `Uint8Array`
3. PTY data: `writeBytes(data)` to xterm.js (debounce-batched) + `feed(text)` for permission detection
4. Background tabs: PTY data buffered in `bgBufferRef`, flushed as single write on tab focus
5. Rust JSONL watcher tails `~/.claude/projects/{encoded_dir}/{session}.jsonl` → Tauri events → `useClaudeState` → Zustand store
6. React re-renders from store: tab dots, status bar, activity feed, subagent cards

### Key Subsystems

| Subsystem | Implementation | Notes |
|-----------|---------------|-------|
| **PTY** | `tauri-plugin-pty` (Rust) + `tauri-pty` npm | Do NOT pass `env: {}` — omit to inherit |
| **Terminal** | xterm.js 6.0 + WebGL + FitAddon | DEC 2026 sync output prevents ink flash |
| **State** | JSONL-based (Rust watcher) | PTY scan only for permission/idle detection |
| **Persistence** | `%LOCALAPPDATA%/claude-tabs/sessions.json` | Frontend-owned via `persist_sessions_json` |
| **Settings** | Zustand + `localStorage` | Recent dirs, CLI capabilities, command usage |
| **Discovery** | `claude --help` + binary scan + plugin/skill file scan | Options, commands, slash commands, hooks |
| **Colors** | Sequential assignment in `claude.ts` | Avoids collisions, preserved across revival |
| **Buffering** | TerminalPanel `visibleRef` + `bgBufferRef` | O(1) rendering — only active tab writes to xterm |
| **Scrollback** | useTerminal `onScroll` handler | 5K default, +10K on scroll-to-top, shrinks at bottom |
| **Dir encoding** | `encode_dir()` — ALL non-alphanumeric → hyphen | `decode_project_dir()` probes filesystem for ambiguity |
| **JSONL resume** | Fast two-point scan | First 30 + last 100 lines, skip middle. O(1) not O(file) |

## Frontend Structure

```
src/
├── App.tsx                              # Root: tab bar, subagent bar, terminals, activity feed
├── store/sessions.ts                    # Zustand: sessions, active tab, subagents
├── store/settings.ts                    # Zustand: preferences, CLI info (persisted to localStorage)
├── hooks/
│   ├── useTerminal.ts                   # xterm.js lifecycle, write batching, dynamic scrollback
│   ├── usePty.ts                        # PTY spawn (tauri-pty npm wrapper)
│   ├── useClaudeState.ts               # JSONL events + permission scan + first message + plan-mode continuation
│   ├── useSubagentWatcher.ts            # Subagent JSONL tracking + local elapsed timer
│   ├── useCliWatcher.ts                 # CLI version + capabilities
│   ├── useCommandDiscovery.ts           # Slash command discovery (binary scan + --help fallback + plugins)
│   └── useNotifications.ts              # Desktop notifications
├── components/
│   ├── Terminal/TerminalPanel.tsx        # PTY + terminal + JSONL watcher + background buffering
│   ├── ActivityFeed/ActivityFeed.tsx     # Action-oriented event feed (state changes, tool uses, subagents)
│   ├── SessionLauncher/SessionLauncher.tsx
│   ├── ResumePicker/ResumePicker.tsx
│   ├── CommandBar/CommandBar.tsx         # Slash commands with usage-based sorting
│   ├── StatusBar/StatusBar.tsx
│   ├── CommandPalette/CommandPalette.tsx
│   ├── SubagentInspector/SubagentInspector.tsx  # Markdown-rendered conversation viewer
│   └── HooksManager/HooksManager.tsx
├── lib/
│   ├── jsonlState.ts                    # JSONL state machine (state + cost + metadata + first message)
│   ├── claude.ts                        # Color assignment, dirToTabName, formatTokenCount
│   ├── theme.ts                         # Theme definitions, CSS variables, xterm theme
│   ├── ptyRegistry.ts                   # Global PTY writer registry
│   ├── terminalRegistry.ts             # Terminal buffer reader registry
│   ├── testHarness.ts                   # Test bridge (state snapshots + command polling)
│   ├── uiConfig.ts                     # Persisted UI config
│   └── perfTrace.ts                    # Performance tracing
└── types/session.ts                     # TypeScript types mirroring Rust (camelCase)
```

## Rust Backend Commands

| Command | Purpose |
|---------|---------|
| `create_session` / `close_session` | Session CRUD |
| `build_claude_args` | SessionConfig → CLI args |
| `start_jsonl_watcher` / `stop_jsonl_watcher` | Tail JSONL files (fast scan for resumed sessions) |
| `start_subagent_watcher` / `stop_subagent_watcher` | Watch subagent JSONL directory |
| `find_continuation_session` | Detect plan-mode forks via sessionId linking |
| `detect_claude_cli` / `check_cli_version` / `get_cli_help` | CLI discovery |
| `list_past_sessions` | Scan `~/.claude/projects/` (async) |
| `get_first_user_message` | First user message from JSONL |
| `persist_sessions_json` / `load_persisted_sessions` | Save/restore sessions |
| `discover_builtin_commands` / `discover_plugin_commands` | Slash command discovery |
| `discover_hooks` / `save_hooks` | Hook configuration |

## Test Harness

State snapshot at `%LOCALAPPDATA%/claude-tabs/test-state.json` (every 2s). Commands via `test-commands.json`.

```bash
cat "$LOCALAPPDATA/claude-tabs/test-state.json"
```

Commands: `createSession`, `closeSession`, `reviveSession`, `setActiveTab`, `getSubagents`, `listSessions`, `sendInput`.

To extend: add state to `captureState()` in `testHarness.ts`, or add command handlers in the polling loop.

## Rules

### Design Principles
- **All colors use CSS custom properties** — never hardcode hex
- **State from real signals only** — JSONL events, PTY output, filesystem structure. Never setTimeout/setInterval to guess state.
- **Fix root causes** — no retries-with-delay, no timer-based heuristics, no buffer-size band-aids
- **Deterministic linking** — Claude Code embeds the old sessionId in continuation JSONL files. Use that, don't scan by timestamp.
- Components in `src/components/<Name>/<Name>.tsx` with co-located CSS
- Rust IPC commands in `commands.rs`, registered in `lib.rs` via `generate_handler!`
- TypeScript types in `src/types/` mirror Rust types with camelCase

### Subprocess Spawns (Rust)
1. Use `tokio::task::spawn_blocking()` to avoid blocking the WebView event loop
2. Add `CREATE_NO_WINDOW` flag on Windows (`cmd.creation_flags(0x08000000)`)

### Session Revival
- Resume target: `resumeSession || sessionId || id` (chains through multiple revivals)
- Create new session BEFORE closing old one (avoids visual flash)
- Preserve color, metadata (nodeSummary, tokens) across revival
- `resumeSession` and `continueSession` are one-shot — never persist in `lastConfig`
- Interrupted sessions (replay ends in thinking/toolUse) force to idle after caught-up
- Historical subagents suppressed during initial replay for resumed sessions

### Don't Repeat These Mistakes
- **DO NOT** use timers to infer session state
- **DO NOT** use Tauri event listeners for PTY data — use `tauri-pty` npm wrapper
- **DO NOT** use React `key=` to swap terminals — destroys xterm.js + PTY
- **DO NOT** pass `env: {}` to PTY spawn — wipes environment
- **DO NOT** conditionally render stateful components (xterm.js) — use CSS `display:none`
- **DO NOT** put React hooks after conditional early returns
- **DO NOT** let `CLAUDECODE` env var leak into spawned PTYs
- **DO NOT** use `|| []` in Zustand selectors (creates new references, causes render storms)
- **DO NOT** sync Rust subprocess spawns on main thread (blocks WebView)
- **DO NOT** seed ActivityFeed with persisted state on startup
- **DO NOT** persist sessions from Rust session manager (metadata is stale)
- **DO NOT** set xterm.js scrollback on every onScroll event (triggers buffer reconstruction)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New session |
| `Ctrl+W` | Close active tab |
| `Ctrl+R` | Resume from history |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Ctrl+1-9` | Jump to tab N |
| `Ctrl+K` | Command palette |
| `Esc` | Close modal / dismiss inspector |
