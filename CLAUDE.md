# Claude Tabs

<!-- Codes: AR=Architecture, BV=Build & Validate, CD=Commands, LO=Layout, DC=Doc Cross-references, FS=Frontend Structure, DR=Development Rules, TH=Theme System -->

Tauri v2 desktop app managing multiple Claude Code CLI sessions in tabs. Rust backend + React/TypeScript frontend. No API key — uses the Claude Code CLI directly.

## Architecture

- [AR-01] Core data flow: React UI (WebView2) communicates with Rust backend via Tauri IPC, which manages PTY sessions to the Claude Code CLI
  ```
  React UI (WebView2) ←→ Tauri IPC ←→ Rust Backend ←→ PTY (ConPTY/openpty) ←→ Claude Code CLI
  ```

## Build & Validate

- [BV-01] Build commands:
  - `npm run build:quick` — Release binary, no installer (~30s after first build)
  - `npm run build:debug` — Debug binary, fastest (~10-15s incremental)
  - `npm run tauri dev` — Dev mode with hot-reload (frontend only, Rust recompiles on change)
  - `npm run tauri build` — Full installer (NSIS on Windows, deb/rpm/appimage on Linux)
  - Binary: `src-tauri/target/release/claude-tabs` (quick) or `src-tauri/target/debug/claude-tabs` (debug)
- [BV-02] Never do a full NSIS build just to test. Use build:quick or build:debug.
- [BV-03] Before every commit: `npx tsc --noEmit` (zero TS errors), `npm test` (all Vitest pass), `cargo check` in src-tauri (zero Rust errors)

## Commands

- [CD-01] Global slash commands in `~/.claude/commands/`:
  | Command | What it does |
  |---------|-------------|
  | `/r` | Review: document change → review + simplify + test (3 agents) in worktree |
  | `/j` | Maintain: prove entries (3 provers) → sync → audit in worktree |
  | `/b` | Build: [commit?] → build → [release+push?] — choose steps upfront |
  | `/rj` | Review then janitor in sequence (2 worktrees) |
  | `/c` | Commit, exit worktree, merge to main |

## Layout

- [LO-01] Main window layout: tab bar, subagent bar, terminal with button bar, command history, command bar, status bar
  ```
  ┌──────────────────────────────────────────────────────────────┐
  │ Tab Bar  [● session1 | ● session2 | + ]                      │
  ├──────────────────────────────────────────────────────────────┤
  │ Subagent Bar  [▐ agent-task-1  12K] [▐ agent-task-2  8K]     │
  ├──────────────────────────────────────────────────────────────┤
  │  Terminal (xterm.js 6.0)                              │ bar │
  │  (CSS display toggle, not unmount)                    │ 28px│
  ├──────────────────────────────────────────────────────────────┤
  │ Command History  [/r] [/j] [/r] ...  (per-session, newest←)  │
  │ Command Bar (slash commands)                                  │
  ├──────────────────────────────────────────────────────────────┤
  │ StatusBar (model, worktree, context%, tokens, duration)        │
  └──────────────────────────────────────────────────────────────┘
  ```

## Doc Cross-references

- [DC-01] See **DOCS/ARCHITECTURE.md** for data flow, state inspection, PTY internals, persistence, and other implementation details.
- [DC-02] See **DOCS/FEATURES.md** for user-facing behaviors.
- [DC-03] See **DOCS/PHILOSOPHY.md** for design principles (democratised voting, worktree isolation, prove cycles).
- [DC-04] All tagged docs are proved. Code implementing a tagged entry is not dead code.

## Frontend Structure

- [FS-01] Frontend source tree:
  ```
  src/
  ├── main.tsx                             # React entry point, theme init
  ├── App.tsx                              # Root: tab bar, subagent bar, terminals
  ├── store/sessions.ts                    # Zustand: sessions, active tab, subagents, command history
  ├── store/settings.ts                    # Zustand: preferences, CLI info (persisted to localStorage)
  ├── hooks/
  │   ├── useTerminal.ts                   # xterm.js lifecycle, write batching, fixed 100K scrollback
  │   ├── usePty.ts                        # PTY spawn wrapper (uses lib/ptyProcess)
  │   ├── useInspectorConnection.ts        # BUN_INSPECT WebSocket lifecycle (connect, retry, disconnect)
  │   ├── useTapPipeline.ts                # Tap event receiver: TCP tap-entry events → classify → dispatch → disk
  │   ├── useTapEventProcessor.ts          # Tap event → store: state reducer, metadata accumulator, subagent tracker
  │   ├── useCommandDiscovery.ts           # Slash command discovery (binary scan + --help fallback + plugins)
  │   ├── useCliWatcher.ts                 # CLI version + capabilities
  │   ├── useNotifications.ts              # Desktop notifications (WinRT toast on Windows, tauri-plugin-notification on Linux)
  │   ├── useCtrlKey.ts                    # Ctrl-key held state for alternate-action highlights
  │   └── useGitStatus.ts                  # Git status polling (2s interval) with change detection
  ├── components/
  │   ├── Terminal/TerminalPanel.tsx        # PTY + terminal + inspector + background buffering
  │   ├── SessionLauncher/SessionLauncher.tsx  # New/resume session modal
  │   ├── ResumePicker/ResumePicker.tsx     # Browse past sessions to resume
  │   ├── CommandBar/CommandBar.tsx         # Slash commands with usage-based sorting
  │   ├── StatusBar/StatusBar.tsx           # Model, subscription, region, context%, cost/TTFT, duration, hooks, subprocess
  │   ├── CommandPalette/CommandPalette.tsx # Ctrl+K search
  │   ├── SubagentInspector/SubagentInspector.tsx  # Markdown-rendered subagent conversation viewer
  │   ├── ConfigManager/ConfigManager.tsx  # 5-tab config workspace (Ctrl+,): Settings, Claude, Hooks, Plugins, Agents
  │   ├── ConfigManager/ThreePaneEditor.tsx # 3-column User/Project/Local scope layout (color-coded)
  │   ├── ConfigManager/SettingsPane.tsx   # Per-scope JSON editor with syntax highlighting overlay
  │   ├── ConfigManager/MarkdownPane.tsx   # Per-scope CLAUDE.md editor with preview toggle
  │   ├── ConfigManager/HooksPane.tsx      # Per-scope hooks CRUD (absorbed from HooksManager)
  │   ├── ConfigManager/PluginsPane.tsx    # Per-scope enabledPlugins (Record<string,boolean>) + mcpServers
  │   ├── ConfigManager/AgentEditor.tsx    # Per-scope agent file list + markdown editor
  │   ├── ConfigManager/SettingsTab.tsx    # Unified per-scope settings layout with schema-driven fields
  │   ├── Icons/Icons.tsx                  # SVG icon components (shared Icon base, currentColor)
  │   ├── ModalOverlay/ModalOverlay.tsx    # Shared modal wrapper
  │   ├── DebugPanel/DebugPanel.tsx        # Structured log viewer: session/module filters, color-coded (Ctrl+Shift+D)
  │   └── DiffPanel/
  │       ├── DiffPanel.tsx                # Git diff side panel (Ctrl+Shift+G): file list, modal trigger
  │       └── DiffModal.tsx                # Side-by-side diff modal (96vw/88vh): highlight.js syntax, file nav
  ├── lib/
  │   ├── inspectorHooks.ts                # INSTALL_TAPS JS expression for BUN_INSPECT (push-based, no polling)
  │   ├── tapClassifier.ts                 # Stateless: TapEntry → TapEvent | null (~42 event types)
  │   ├── tapEventBus.ts                   # Per-session synchronous pub/sub for classified events
  │   ├── tapStateReducer.ts               # Pure: (SessionState, TapEvent) → SessionState
  │   ├── tapMetadataAccumulator.ts        # Stateful: events → Partial<SessionMetadata> diffs
  │   ├── tapSubagentTracker.ts            # Subagent lifecycle: spawn → run → complete/kill
  │   ├── inspectorPort.ts                 # Inspector port allocation and registry
  │   ├── claude.ts                        # Color assignment, model resolution, resume helpers, stripWorktreeFlags, buildClaudeArgs
  │   ├── theme.ts                         # Theme definitions, CSS variable setter, xterm theme
  │   ├── ptyProcess.ts                    # Direct PTY wrapper + active PID cleanup registry
  │   ├── inputAccumulator.ts              # PTY input line accumulator for slash-command detection
  │   ├── ptyRegistry.ts                   # Global PTY writer + kill registry + slash-command detection via LineAccumulator
  │   ├── terminalRegistry.ts             # Terminal buffer reader registry
  │   ├── paths.ts                         # Path helpers, IS_WINDOWS detection, platform-aware normalizePath, worktree detection, tab grouping
  │   ├── settingsSchema.ts               # CLI settings.json schema discovery + parsing
  │   ├── debugLog.ts                      # Structured debug logging (dlog function, session-scoped entries)
  │   ├── uiConfig.ts                     # Persisted UI configuration
  │   ├── perfTrace.ts                    # Performance tracing utilities
  │   └── diffParser.ts                   # Git porcelain/numstat/unified-diff parsers
  └── types/
      ├── session.ts                       # TypeScript types mirroring Rust (camelCase)
      ├── tapEvents.ts                     # Discriminated union of ~42 tap event types
      ├── ipc.ts                           # Tauri IPC command signatures
      └── git.ts                           # Git status and diff types (GitStatusData, FileDiff, DiffLine)
  ```

## Development Rules

- [DR-01] Rust IPC commands in `commands.rs` and `jsonl_watcher.rs`, registered in `lib.rs` via `generate_handler!`
- [DR-02] TypeScript types in `src/types/` mirror Rust types with camelCase
- [DR-03] Zustand stores in `src/store/`, hooks in `src/hooks/`
- [DR-04] Components in `src/components/<Name>/<Name>.tsx` with co-located CSS
- [DR-05] Add tests for any new pure-logic functions in `src/lib/` and store actions in `src/store/`
- [DR-06] All Rust commands that spawn subprocesses MUST use `tokio::task::spawn_blocking()` to avoid blocking the WebView event loop
- [DR-07] All Rust commands that spawn subprocesses MUST add `CREATE_NO_WINDOW` flag on Windows (`cmd.creation_flags(0x08000000)`)
- [DR-08] Use `dlog(module, sessionId, message, level?)` from `src/lib/debugLog.ts` for all application logging. Never use raw `console.log/warn/error`. Module names: `pty`, `inspector`, `terminal`, `session`, `config`, `launcher`, `resume`, `tap`. Pass `sessionId` when in scope, `null` otherwise. Use `"DEBUG"` level for verbose tracing, `"WARN"`/`"ERR"` for problems.

## Theme System

- [TH-01] All colors are CSS custom properties on `:root` — components use CSS variables, not hardcoded hex (exception: model rarity colors in `claude.ts` are fixed hex for cross-theme consistency). Applied at startup via `applyTheme()`. xterm.js colors from `getXtermTheme()` reading CSS variables.
- [TH-02] Key variables: `--bg-primary`, `--bg-surface`, `--accent` (clay), `--accent-secondary` (blue), `--accent-tertiary` (purple), `--term-bg`, `--term-fg`
