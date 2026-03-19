# Claude Tabs

Tauri v2 desktop app managing multiple Claude Code CLI sessions in tabs. Rust backend + React/TypeScript frontend. No API key — uses the Claude Code CLI directly.

```
React UI (WebView2) ←→ Tauri IPC ←→ Rust Backend ←→ ConPTY ←→ Claude Code CLI
```

## Build & Validate

```bash
npm run build:quick     # Release binary, no installer (~30s after first build)
npm run build:debug     # Debug binary, fastest (~10-15s incremental)
npm run tauri dev       # Dev mode with hot-reload (frontend only, Rust recompiles on change)
npm run tauri build     # Full NSIS installer (only for releases)
```

Portable exe: `src-tauri/target/release/claude-tabs.exe` (quick) or `src-tauri/target/debug/claude-tabs.exe` (debug). Never do a full NSIS build just to test.

**Before every commit:**
```bash
npx tsc --noEmit           # Zero TypeScript errors
npm test                   # All Vitest unit tests pass
cargo check (in src-tauri) # Zero Rust errors
```

## Agents

Role-specific agents in `.claude/agents/`. Use these for specialized tasks:

| Agent | When to use |
|-------|-------------|
| **test-runner** | Run tests, find coverage gaps, write new tests |
| **code-reviewer** | Review changes for bugs, anti-patterns, CLAUDE.md compliance |
| **qa** | Build app, **launch it**, reproduce/verify via test harness or screenshots — never just compile |
| **code-simplifier** | Clean up dead code, simplify logic, fix naming |
| **builder** | Build releases, bump versions, create GitHub releases |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Tab Bar  [● session1 | ● session2 | + ]                      │
├──────────────────────────────────────────────────────────────┤
│ Subagent Bar  [▐ agent-task-1  12K] [▐ agent-task-2  8K]     │
├────────────────────────────────────┬─────────────────────────┤
│  Terminal (xterm.js 6.0)           │  ActivityFeed           │
│  (CSS display toggle, not unmount) │  (actions log)          │
├────────────────────────────────────┴─────────────────────────┤
│ Command Bar (slash commands)                                  │
├──────────────────────────────────────────────────────────────┤
│ StatusBar (model, cost, tokens, duration)                     │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User types in xterm.js → `onData` → PTY `write` → ConPTY → Claude stdin
2. Claude stdout → ConPTY → `tauri-pty` npm `onData` → `Uint8Array`
3. PTY data handler: `writeBytes(data)` to xterm.js (debounce-batched, 4ms/50ms) + `feed(text)` for permission detection
4. Background tabs: PTY data buffered in `bgBufferRef`, flushed as single write on tab focus (O(1) rendering)
5. Rust JSONL watcher tails `~/.claude/projects/{encoded_dir}/{session}.jsonl` → Tauri events → `useClaudeState` → Zustand store
6. Resumed sessions: fast two-point scan (first 30 + last 100 lines from final 256KB), skip middle — O(1) not O(file)
7. React re-renders from store: tab state dots, status bar, activity feed, subagent cards

### Subsystems

| Subsystem | Implementation | Notes |
|-----------|---------------|-------|
| **PTY** | `tauri-plugin-pty` (Rust) + `tauri-pty` npm | Omit `env` to inherit (never pass `env: {}`) |
| **Terminal** | xterm.js 6.0 + WebGL + FitAddon | DEC 2026 sync output prevents ink flash |
| **State detection** | JSONL-based (Rust watcher) | PTY scan only for permission/idle detection |
| **Persistence** | `%LOCALAPPDATA%/claude-tabs/sessions.json` | Frontend-owned via `persist_sessions_json`; `beforeunload` flush |
| **Settings** | Zustand + `localStorage` | Recent dirs, CLI capabilities, command usage |
| **Discovery** | `claude --help` + binary scan + plugin/skill file scan | `--help` fallback when binary unavailable |
| **Colors** | Sequential assignment in `claude.ts` | Avoids collisions, preserved across revival |
| **Background buffering** | `visibleRef` + `bgBufferRef` in TerminalPanel | Buffered when hidden, flushed on focus |
| **Scrollback** | `useTerminal` onScroll handler | 5K default, grows 10K on scroll-to-top, shrinks at bottom |
| **Dir encoding** | `encode_dir()` — all non-alphanumeric → hyphen | `decode_project_dir()` probes filesystem to resolve ambiguity |
| **Plan-mode continuation** | `find_continuation_session` + `onConversationEnd` | Detects new JSONL file via embedded sessionId, restarts watcher |

### Rust Commands

| Command | Purpose |
|---------|---------|
| `create_session` / `close_session` | Session CRUD |
| `build_claude_args` | SessionConfig → CLI args (`--resume`, `--session-id`, `--project-dir`, etc.) |
| `start_jsonl_watcher` / `stop_jsonl_watcher` | Tail JSONL files, emit events (fast scan for resumed sessions) |
| `start_subagent_watcher` / `stop_subagent_watcher` | Watch subagent JSONL directory |
| `find_continuation_session` | Detect plan-mode forks via sessionId in first events of other JSONL files |
| `detect_claude_cli` / `check_cli_version` / `get_cli_help` | CLI discovery |
| `list_past_sessions` | Scan `~/.claude/projects/` for resumable sessions (async, `spawn_blocking`) |
| `get_first_user_message` | Read first user message from session JSONL |
| `persist_sessions_json` / `load_persisted_sessions` | Save/restore sessions |
| `discover_builtin_commands` / `discover_plugin_commands` | Slash command discovery |
| `discover_hooks` / `save_hooks` | Hook configuration |

### Frontend Structure

```
src/
├── App.tsx                              # Root: tab bar, subagent bar, terminals, activity feed
├── store/sessions.ts                    # Zustand: sessions, active tab, subagents
├── store/settings.ts                    # Zustand: preferences, CLI info (persisted to localStorage)
├── hooks/
│   ├── useTerminal.ts                   # xterm.js lifecycle, write batching, dynamic scrollback
│   ├── usePty.ts                        # PTY spawn (tauri-pty npm wrapper)
│   ├── useClaudeState.ts               # JSONL events, permission scan, first message, plan-mode continuation
│   ├── useSubagentWatcher.ts            # Subagent JSONL tracking, local elapsed timer
│   ├── useCommandDiscovery.ts           # Slash command discovery (binary scan + --help fallback + plugins)
│   ├── useCliWatcher.ts                 # CLI version + capabilities
│   ├── useNotifications.ts              # Desktop notifications
│   └── useShiftKey.ts                   # Shared shift-key held state
├── components/
│   ├── Terminal/TerminalPanel.tsx        # PTY + terminal + JSONL watcher + background buffering
│   ├── ActivityFeed/ActivityFeed.tsx     # Action-oriented feed (state changes, tool uses, subagents)
│   ├── SessionLauncher/SessionLauncher.tsx  # New/resume session modal
│   ├── ResumePicker/ResumePicker.tsx     # Browse past sessions to resume
│   ├── CommandBar/CommandBar.tsx         # Slash commands with usage-based sorting
│   ├── StatusBar/StatusBar.tsx           # Model, cost, tokens, duration
│   ├── CommandPalette/CommandPalette.tsx # Ctrl+K search
│   ├── SubagentInspector/SubagentInspector.tsx  # Markdown-rendered subagent conversation viewer
│   └── HooksManager/HooksManager.tsx    # Hook configuration UI
├── lib/
│   ├── jsonlState.ts                    # JSONL state machine (state + cost + metadata + first message)
│   ├── claude.ts                        # Color assignment, dirToTabName, formatTokenCount
│   ├── theme.ts                         # Theme definitions, CSS variable setter, xterm theme
│   ├── ptyRegistry.ts                   # Global PTY writer registry
│   ├── terminalRegistry.ts             # Terminal buffer reader registry
│   ├── testHarness.ts                   # Test bridge (writes state to JSON, accepts commands)
│   ├── uiConfig.ts                     # Persisted UI configuration
│   └── perfTrace.ts                    # Performance tracing utilities
└── types/session.ts                     # TypeScript types mirroring Rust (camelCase)
```

### Theme System

All colors are CSS custom properties on `:root` — components never use hardcoded hex. Applied at startup via `applyTheme()`. xterm.js colors from `getXtermTheme()` reading CSS variables.

Key variables: `--bg-primary`, `--bg-surface`, `--accent` (clay), `--accent-secondary` (blue), `--accent-tertiary` (purple), `--term-bg`, `--term-fg`.

## Development Rules

### Code Organization
- Rust IPC commands in `commands.rs`, registered in `lib.rs` via `generate_handler!`
- TypeScript types in `src/types/` mirror Rust types with camelCase
- Zustand stores in `src/store/`, hooks in `src/hooks/`
- Components in `src/components/<Name>/<Name>.tsx` with co-located CSS
- Add tests for any new pure-logic functions in `src/lib/`

### Subprocess Spawns (Rust)
All Rust commands that spawn subprocesses MUST:
1. Use `tokio::task::spawn_blocking()` to avoid blocking the WebView event loop
2. Add `CREATE_NO_WINDOW` flag on Windows (`cmd.creation_flags(0x08000000)`)

### Behavioral Contracts
See **FEATURES.md** for expected behaviors (session resume, revival, activity feed, tab sizing, terminal rendering, etc.). All agents must read FEATURES.md before modifying or removing code.

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
