# Claude Tabs — Development Guide

## Iteration Speed is Everything

Fast builds and manual verification are the core workflow. Never do a full NSIS build just to test — use quick builds.

```bash
npm run build:quick     # Release binary, no installer (~30s after first build)
npm run build:debug     # Debug binary, fastest (~10-15s incremental)
npm run tauri dev       # Dev mode with hot-reload (frontend only, Rust recompiles on change)
npm run tauri build     # Full NSIS installer (only for releases)
```

The portable exe is at `src-tauri/target/release/claude-tabs.exe` (quick) or `src-tauri/target/debug/claude-tabs.exe` (debug).

### Validation (before every commit)

```bash
npx tsc --noEmit           # Zero TypeScript errors
npm test                   # All Vitest unit tests pass
cargo check (in src-tauri) # Zero Rust errors
```

### Manual Testing (MANDATORY for every change)

You MUST personally test every change before delivering. Do NOT guess at fixes or theorize without evidence. The workflow is:

1. Add logging/instrumentation to observe actual behavior
2. Launch the app (`build:quick` or `tauri dev`) and reproduce the issue
3. Read the test harness state (`%LOCALAPPDATA%/claude-tabs/test-state.json`) to understand what's happening
4. Make a targeted fix based on observed evidence
5. Re-run the same reproduction to verify the fix works
6. Only then commit and deliver

If the test harness can't observe an issue, EXTEND IT. Never say "I can't test this."

## What is this?

A Tauri v2 desktop app that manages multiple Claude Code CLI sessions in tabs. Rust backend + React/TypeScript frontend. No API key — uses the Claude Code CLI directly.

## Architecture

```
React UI (WebView2) ←→ Tauri IPC ←→ Rust Backend ←→ ConPTY ←→ Claude Code CLI
```

```
┌──────────────────────────────────────────────────────────────┐
│ Tab Bar  [● session1 | ● session2 | + ]                      │
├──────────────────────────────────────────────────────────────┤
│ Subagent Bar  [▐ agent-task-1  12K] [▐ agent-task-2  8K]    │
├────────────────────────────────────────────┬─────────────────┤
│  Terminal (xterm.js 6.0)                   │  ActivityFeed   │
│  (active session, CSS display toggle)      │  (IRC-style)    │
├────────────────────────────────────────────┴─────────────────┤
│ Command Bar (slash commands)                                  │
├──────────────────────────────────────────────────────────────┤
│ StatusBar (model, cost, tokens, duration)                    │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User types in xterm.js → `onData` → PTY `write` → ConPTY → Claude stdin
2. Claude stdout → ConPTY → `tauri-pty` npm `onData` callback → `Uint8Array`
3. PTY data handler: `writeBytes(data)` to xterm.js (debounce-batched) + `feed(text)` for permission detection
4. Rust JSONL watcher tails `~/.claude/projects/{encoded_dir}/{session}.jsonl` → Tauri events → `useClaudeState` updates Zustand store
5. React re-renders from store: tab state dots, status bar, activity feed, subagent cards

### Key Subsystems

| Subsystem | Implementation | Notes |
|-----------|---------------|-------|
| **PTY** | `tauri-plugin-pty` (Rust) + `tauri-pty` npm | Do NOT pass `env: {}` — omit to inherit |
| **Terminal** | xterm.js 6.0 + WebGL + FitAddon | Native DEC 2026 sync output prevents ink flash |
| **State detection** | JSONL-based (Rust watcher) | PTY scan only for permission detection |
| **Persistence** | Sessions → `%LOCALAPPDATA%/claude-tabs/sessions.json` | Frontend-owned via `persist_sessions_json` |
| **Settings** | Zustand + `localStorage` | Recent dirs, CLI capabilities, command usage |
| **Discovery** | `claude --help` + binary scan + plugin/skill file scan | Options, commands, slash commands, hooks |
| **Colors** | Sequential assignment in `claude.ts` | Avoids collisions, preserved across revival |
| **Dir encoding** | `encode_dir()` — ALL non-alphanumeric → hyphen | `decode_project_dir()` probes filesystem to resolve ambiguity |

### Rust Backend

| Command | Purpose |
|---------|---------|
| `create_session` / `close_session` | Session CRUD |
| `build_claude_args` | SessionConfig → CLI args (`--resume`, `--session-id`, `--project-dir`, etc.) |
| `start_jsonl_watcher` / `stop_jsonl_watcher` | Tail JSONL files, emit events |
| `start_subagent_watcher` / `stop_subagent_watcher` | Watch subagent JSONL directory |
| `detect_claude_cli` / `check_cli_version` / `get_cli_help` | CLI discovery |
| `list_past_sessions` | Scan `~/.claude/projects/` for resumable sessions (async) |
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
│   ├── useTerminal.ts                   # xterm.js lifecycle, debounced write batching
│   ├── usePty.ts                        # PTY spawn (tauri-pty npm wrapper)
│   ├── useClaudeState.ts                # JSONL event listener + permission PTY scan + first message
│   ├── useSubagentWatcher.ts            # Subagent JSONL tracking + local elapsed timer
│   ├── useCliWatcher.ts                 # CLI version + capabilities
│   └── useNotifications.ts              # Desktop notifications
├── components/
│   ├── Terminal/TerminalPanel.tsx        # PTY + terminal + JSONL watcher per session
│   ├── ActivityFeed/ActivityFeed.tsx     # IRC-style event feed
│   ├── SessionLauncher/SessionLauncher.tsx  # New/resume session modal
│   ├── ResumePicker/ResumePicker.tsx     # Browse past sessions to resume
│   ├── CommandBar/CommandBar.tsx         # Slash command buttons
│   ├── StatusBar/StatusBar.tsx           # Model, cost, tokens, duration
│   ├── CommandPalette/CommandPalette.tsx # Ctrl+K search
│   ├── SubagentInspector/SubagentInspector.tsx  # Subagent conversation viewer
│   └── HooksManager/HooksManager.tsx    # Hook configuration UI
├── lib/
│   ├── jsonlState.ts                    # JSONL event processor (state machine + cost + metadata)
│   ├── theme.ts                         # Theme definitions, CSS variable setter, xterm theme
│   ├── claude.ts                        # CLI helpers, color assignment, dirToTabName, formatTokenCount
│   ├── ptyRegistry.ts                   # Global PTY writer registry
│   ├── terminalRegistry.ts             # Terminal buffer reader registry
│   ├── testHarness.ts                   # Test bridge (writes state to JSON, accepts commands)
│   └── uiConfig.ts                     # Persisted UI configuration (dead session age, resume settings)
└── types/session.ts                     # TypeScript types mirroring Rust (camelCase)
```

### Theme System

All colors are CSS custom properties on `:root`. Components never use hardcoded hex. Theme is applied at startup via `applyTheme()`. xterm.js colors come from `getXtermTheme()` reading CSS variables.

Key variables: `--bg-primary`, `--bg-surface`, `--accent` (clay), `--accent-secondary` (blue), `--accent-tertiary` (purple), `--term-bg`, `--term-fg`.

## Test Harness

The app includes a test bridge (`src/lib/testHarness.ts`) that writes a JSON snapshot of app state to `%LOCALAPPDATA%/claude-tabs/test-state.json` every 2 seconds. It also polls for commands from `test-commands.json`.

### Reading State

```bash
cat "$LOCALAPPDATA/claude-tabs/test-state.json"
```

Contains: session count/states/metadata, CLI version, option count, slash command count, active tab, subagents, activity feed entries, console logs.

### Sending Commands

Write a JSON command to `test-commands.json`:

```json
{ "command": "createSession", "args": { "name": "test", "config": { "workingDir": "C:/path" } } }
```

Available commands: `createSession`, `closeSession`, `reviveSession`, `setActiveTab`, `getSubagents`, `listSessions`, `sendInput`.

### Extending the Harness

1. Add state to the `captureState()` function in `testHarness.ts`
2. Read it from `test-state.json` after launching the app
3. For new commands, add a handler in the command polling loop

## Key Conventions

### Code Structure
- Rust IPC commands in `commands.rs`, registered in `lib.rs` via `generate_handler!`
- TypeScript types in `src/types/` mirror Rust types with camelCase
- Zustand stores in `src/store/`, hooks in `src/hooks/`
- Components in `src/components/<Name>/<Name>.tsx` with co-located CSS
- **All colors use CSS custom properties** — never hardcode hex

### Subprocess Spawns
All Rust commands that spawn subprocesses MUST:
1. Use `tokio::task::spawn_blocking()` to avoid blocking the WebView event loop
2. Add `CREATE_NO_WINDOW` flag on Windows (`cmd.creation_flags(0x08000000)`)

### Session Revival
- Use `resumeSession || sessionId || id` for the resume target (chains through multiple revivals)
- Check JSONL file existence via `session_has_conversation` (not `assistantMessageCount`)
- Skip `--session-id` when using `--resume` or `--continue`
- Preserve metadata (nodeSummary, tokens) across revival
- `resumeSession` and `continueSession` are one-shot — never persist them in `lastConfig`

### Terminal Write Batching
PTY data is debounce-batched in `useTerminal.ts` before writing to xterm.js (4ms quiet / 50ms max). xterm.js 6.0's native DEC 2026 synchronized output handles ink's redraw sequences. The batching is defense-in-depth for data outside sync blocks.

### Directory Encoding
`encode_dir()` replaces ALL non-alphanumeric characters with hyphens (matching Claude Code). `decode_project_dir()` resolves ambiguity by probing the filesystem — at each hyphen, it tries period/hyphen/space-joined directory names (longest match first) before falling back to treating hyphens as path separators.

### State Detection
State MUST be derived from real signals (JSONL events, PTY output patterns), never from arbitrary timers. **DO NOT** use setTimeout/setInterval to guess state transitions (e.g. "if no JSONL for 15s, assume idle"). If you can't determine the state from the data, that's a gap in the data — fix the data source, don't paper over it with timers. Timer-based heuristics are unreliable, untestable, and always wrong in edge cases.

### Things that broke before (don't repeat)
- **DO NOT** use arbitrary timers/timeouts to infer session state (see State Detection above)
- **DO NOT** use Tauri event listeners for PTY data — use `tauri-pty` npm wrapper
- **DO NOT** use React `key=` to swap terminals — destroys xterm.js + PTY
- **DO NOT** pass `env: {}` to PTY spawn — wipes environment
- **DO NOT** conditionally render stateful components (xterm.js) — use CSS `display:none`
- **DO NOT** put React hooks after conditional early returns
- **DO NOT** let `CLAUDECODE` env var leak into spawned PTYs
- **DO NOT** use `|| []` in Zustand selectors (creates new references, causes render storms)
- **DO NOT** sync Rust subprocess spawns on main thread (blocks WebView for seconds)
- **DO NOT** seed the ActivityFeed with persisted state on startup (users see it as noise)
- **DO NOT** persist sessions from the Rust session manager (metadata is stale — frontend owns persistence via `persist_sessions_json`)
- **DO NOT** persist `resumeSession`/`continueSession` in `lastConfig` (one-shot fields, causes launcher to stick in resume mode)
- **DO NOT** try to fix terminal flash by removing WebGL or memoizing useTerminal (the fix is xterm.js 6.0 DEC 2026 sync + debounced batching)
- **DO NOT** use xterm.js 5.x — v6.0 is required for synchronized output support

## Unit Tests

- `jsonlState` 43, `claude` 22, `deadSession` 18, `theme` 4, `ptyRegistry` 6

Run with `npm test`. Add tests for any new pure-logic functions in `src/lib/`.

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
