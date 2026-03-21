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

## Commands

Global slash commands in `~/.claude/commands/`. Type these in any conversation:

| Command | What it does |
|---------|-------------|
| `/r` | Review: document change → review + simplify + test (3 agents). Repeatable. |
| `/j` | Maintain: prove entries (2 parallel provers) → sync CLAUDE.md → folder audit → hooks |
| `/b` | Build: [commit?] → build → [release+push?] — prompts at each step |

## Layout

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
│ StatusBar (model, cost, tokens, duration)                     │
└──────────────────────────────────────────────────────────────┘
```

See **DOCS/ARCHITECTURE.md** for data flow, state inspection, PTY internals, persistence, and other implementation details.

### Frontend Structure

```
src/
├── App.tsx                              # Root: tab bar, subagent bar, terminals
├── store/sessions.ts                    # Zustand: sessions, active tab, subagents, command history
├── store/settings.ts                    # Zustand: preferences, CLI info (persisted to localStorage)
├── hooks/
│   ├── useTerminal.ts                   # xterm.js lifecycle, write batching, fixed 100K scrollback
│   ├── usePty.ts                        # PTY spawn wrapper (uses lib/ptyProcess)
│   ├── useInspectorState.ts             # BUN_INSPECT WebSocket: state detection, metadata, subagent tracking
│   ├── useCommandDiscovery.ts           # Slash command discovery (binary scan + --help fallback + plugins)
│   ├── useCliWatcher.ts                 # CLI version + capabilities
│   ├── useNotifications.ts              # Desktop notifications (WinRT toast, click-to-switch)
│   └── useCtrlKey.ts                    # Ctrl-key held state for alternate-action highlights
├── components/
│   ├── Terminal/TerminalPanel.tsx        # PTY + terminal + inspector + background buffering
│   ├── SessionLauncher/SessionLauncher.tsx  # New/resume session modal
│   ├── ResumePicker/ResumePicker.tsx     # Browse past sessions to resume
│   ├── CommandBar/CommandBar.tsx         # Slash commands with usage-based sorting
│   ├── StatusBar/StatusBar.tsx           # Model, cost, tokens, duration
│   ├── CommandPalette/CommandPalette.tsx # Ctrl+K search
│   ├── SubagentInspector/SubagentInspector.tsx  # Markdown-rendered subagent conversation viewer
│   ├── ConfigManager/ConfigManager.tsx  # 5-tab config workspace (Ctrl+,): Settings, Claude, Hooks, Plugins, Agents
│   ├── ConfigManager/ThreePaneEditor.tsx # 3-column User/Project/Local scope layout (color-coded)
│   ├── ConfigManager/SettingsPane.tsx   # Per-scope JSON editor with syntax highlighting overlay
│   ├── ConfigManager/MarkdownPane.tsx   # Per-scope CLAUDE.md editor with preview toggle
│   ├── ConfigManager/HooksPane.tsx      # Per-scope hooks CRUD (absorbed from HooksManager)
│   ├── ConfigManager/PluginsPane.tsx    # Per-scope enabledPlugins (Record<string,boolean>) + mcpServers
│   ├── ConfigManager/AgentEditor.tsx    # Per-scope agent file list + markdown editor
│   ├── Icons/Icons.tsx                  # SVG icon components (shared Icon base, currentColor)
│   ├── ThinkingPanel/ThinkingPanel.tsx  # Thinking block viewer (Ctrl+I)
│   ├── ModalOverlay/ModalOverlay.tsx    # Shared modal wrapper
│   └── DebugPanel/DebugPanel.tsx        # Debug log viewer (Ctrl+Shift+D)
├── lib/
│   ├── inspectorHooks.ts                # INSTALL_HOOK + POLL_STATE JS expressions for BUN_INSPECT
│   ├── inspectorPort.ts                 # Inspector port allocation and registry
│   ├── claude.ts                        # Color assignment, dirToTabName, formatTokenCount
│   ├── theme.ts                         # Theme definitions, CSS variable setter, xterm theme
│   ├── ptyProcess.ts                    # Direct PTY wrapper + active PID cleanup registry
│   ├── ptyRegistry.ts                   # Global PTY writer registry
│   ├── terminalRegistry.ts             # Terminal buffer reader registry
│   ├── paths.ts                         # Path helpers, tab grouping (groupSessionsByDir, swapWithinGroup, TabGroup)
│   ├── settingsSchema.ts               # CLI settings.json schema discovery + parsing
│   ├── testHarness.ts                   # Test bridge (writes state to JSON, accepts commands)
│   ├── uiConfig.ts                     # Persisted UI configuration
│   └── perfTrace.ts                    # Performance tracing utilities
└── types/
    ├── session.ts                       # TypeScript types mirroring Rust (camelCase)
    └── ipc.ts                           # Tauri IPC command signatures
```

### Theme System

All colors are CSS custom properties on `:root` — components use CSS variables, not hardcoded hex (exception: model rarity colors in `claude.ts` are fixed hex for cross-theme consistency). Applied at startup via `applyTheme()`. xterm.js colors from `getXtermTheme()` reading CSS variables.

Key variables: `--bg-primary`, `--bg-surface`, `--accent` (clay), `--accent-secondary` (blue), `--accent-tertiary` (purple), `--term-bg`, `--term-fg`.

## Development Rules

### Code Organization
- Rust IPC commands in `commands.rs`, registered in `lib.rs` via `generate_handler!`
- TypeScript types in `src/types/` mirror Rust types with camelCase
- Zustand stores in `src/store/`, hooks in `src/hooks/`
- Components in `src/components/<Name>/<Name>.tsx` with co-located CSS
- Add tests for any new pure-logic functions in `src/lib/` and store actions in `src/store/`

### Subprocess Spawns (Rust)
All Rust commands that spawn subprocesses MUST:
1. Use `tokio::task::spawn_blocking()` to avoid blocking the WebView event loop
2. Add `CREATE_NO_WINDOW` flag on Windows (`cmd.creation_flags(0x08000000)`)

### Documentation
- **DOCS/FEATURES.md** — user-facing behaviors, tagged `[XX-NN]`. Read before modifying UI code.
- **DOCS/ARCHITECTURE.md** — technical implementation details, tagged `[XX-NN]`. Read before modifying internals.
- Code implementing a tagged entry is not dead code.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New session |
| `Ctrl+W` | Close active tab |
| `Ctrl+Shift+R` | Resume from history |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Alt+1-9` | Jump to tab N |
| `Ctrl+K` | Command palette |
| `Ctrl+Shift+U` | Clear all input lines |
| `Ctrl+I` | Toggle thinking panel |
| `Ctrl+,` | Config manager |
| `Ctrl+Shift+D` | Toggle debug log panel |
| `Ctrl+E` | Rename active tab |
| `Esc` | Close modal / dismiss inspector |
