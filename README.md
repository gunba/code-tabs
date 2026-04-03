# Claude Tabs

A desktop app for managing multiple Claude Code CLI sessions in tabs. Rust backend, React/TypeScript frontend, no API key required — uses your Claude Code CLI directly.

![Screenshot](ss.png)

## Features

### Terminal Tabs
- Run multiple Claude Code sessions side by side with fixed-width tabs
- Inline rename, drag-to-reorder, working-directory grouping
- Dead tabs persist at reduced opacity; clicking a dead tab auto-respawns the session
- Background buffering — hidden tabs accumulate PTY output and flush it as a single write on focus

### Session Resume
- Browse past conversations (Ctrl+Shift+R) with first/last message preview, model badges, and content search
- Chain merging for plan-mode forks — linked sessions collapse into a single card
- Config caching preserves model, permissions, effort, agent, budgets, and system prompt across resumes
- Worktree flags (`-w`) auto-stripped on resume to prevent duplicate worktree creation

### Session Launcher
- Visual CLI builder with every flag as a clickable pill and live command preview
- Permission mode selector, skip-perms toggle, model picker, effort dial
- Quick launch (Ctrl+Shift+T) bypasses the modal using saved defaults
- Utility mode for non-session commands (`--version`, `--help`, `--print`)
- Auto-start toggles for TAP recording and terminal recording

### Subagent Tracking
- Live subagent status bar with elapsed time, token/cost attribution, and state indicators
- Conversation inspector renders full subagent dialogue with markdown and tool blocks
- Nested subagent support via agentId-based routing
- Active cards pulse; idle subagents remain visible until session ends

### Command Bar
- Slash commands auto-discovered from your Claude Code installation (binary scan + plugin directories)
- Usage-based sorting with WoW-rarity heat gradient (green -> blue -> purple -> orange)
- Click types without sending; Ctrl+Click sends immediately
- Per-session command history strip with re-send on click
- Skill invocation results displayed in a separate strip with success/failure coloring

### Configuration Manager (Ctrl+,)
- 10-tab modal: Settings, Env Vars, Claude.md, Hooks, Plugins, Agents, Prompts, Skills, Providers, Recording
- Three-scope editing: User (`~/.claude/`), Project (`.claude/`), Project Local (`.claude/.local`)
- JSON settings editor with syntax highlighting, schema validation, and click-to-insert reference panel
- CLAUDE.md editor with preview toggle per scope
- Hooks CRUD with non-destructive saves (preserves unknown fields)
- Plugin marketplace with search, sort, install/uninstall/toggle
- Agent and skills editors with per-scope file management
- Env var editor with searchable reference catalog
- System prompt diffing and rule generation
- Multi-provider routing configuration
- TAP recording category toggles grouped by subsystem

### Git Integration (Ctrl+Shift+G)
- Diff side panel with staged, unstaged, and untracked sections
- Per-file insertion/deletion stats with pulse animation on change
- Side-by-side diff modal with syntax highlighting (23 languages)
- File navigation with Alt+Left/Right; diff cache with stale-response protection
- Git status polling (2s) with change detection

### Debug & Inspection
- Debug panel (Ctrl+Shift+D) with structured logging, severity coloring, and 2000-entry ring buffer
- Cross-session terminal search (Ctrl+Shift+F) with regex support and 500-result cap
- Context viewer showing captured system prompt blocks with token stats and cache boundaries
- Inspector connection with WebSocket lifecycle, retry strategy, and port allocation (6400-6499)

### TAP Event Pipeline
- Push-based architecture: TCP socket receives raw entries, classifier produces ~45 typed events
- State derived from events (no terminal polling): session state machine, metadata accumulation, subagent lifecycle
- 22 flag-gated tap categories (console, fs, spawn, fetch, net, stream, etc.)

### Status Bar
- Model, API latency, subscription tier, region, session duration
- Hook count, active subprocess count, permission mode
- Context button opens system prompt viewer when available
- All icons are inline SVG (no emoji)

### Desktop Notifications
- Background tab alerts on response complete, permission needed, or error
- Click-to-focus: clicking a toast switches to the target tab
- Rate-limited to 1 per session per 30 seconds
- Custom WinRT toasts with click callbacks (not Tauri plugin)

### Theme & Appearance
- CSS variable color system with dark theme and native Windows decorations
- Frosted glass modals (backdrop blur + color-mix)
- Inter + Cascadia Code/Fira Code/JetBrains Mono font stack
- xterm.js themes derived from CSS variables

### Terminal
- WebGL renderer with context loss recovery and canvas fallback
- 1M fixed scrollback, DEC 2026 synchronized output, batch-debounced writes (4ms quiet / 50ms max)
- Output filter strips OSC 52 (clipboard hijack), DCS sequences, and C1 controls
- Scroll-to-last-message via prompt marker detection (Ctrl+middle-click)

## Install

Download the latest `.exe` from [Releases](../../releases) or build from source:

```bash
npm install
npm run tauri build
```

The installer is at `src-tauri/target/release/bundle/nsis/`.

Or run the portable exe directly: `src-tauri/target/release/claude-tabs.exe`.

### Requirements

- Windows 10 (21H2+) or Windows 11
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) installed and authenticated
- WebView2 runtime (pre-installed on Windows 11)

## Development

```bash
npm run tauri dev        # Dev mode with hot-reload
npx tsc --noEmit         # Type-check
npm test                 # Unit tests (Vitest)
npm run build:quick      # Quick build (no NSIS installer)
npm run build:debug      # Debug build (no NSIS installer)
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New session |
| Ctrl+Shift+T | Quick launch (saved defaults) |
| Ctrl+W | Close active tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle tabs (skips dead) |
| Alt+1-9 | Jump to tab N |
| Ctrl+K | Command palette |
| Ctrl+, | Configuration manager |
| Ctrl+Shift+R | Resume past session |
| Ctrl+Shift+D | Toggle debug panel |
| Ctrl+Shift+F | Cross-session terminal search |
| Ctrl+Shift+G | Git diff panel |
| Ctrl+Home / Ctrl+End | Scroll to top / bottom |
| Ctrl+Wheel | Snap to top / bottom |
| Ctrl+Middle-click | Scroll to last message |
| Alt+Left / Alt+Right | Prev / next file in diff modal |
| Shift+Click tab | Relaunch with new options |
| Right-click tab | Context menu (copy ID, rename, etc.) |
| Escape | Dismiss (ordered: context menu, palette, side panel, config, resume, launcher, inspector) |

## Architecture

```
React 19 + TypeScript (WebView2)
  |
  Tauri v2 IPC
  |
  Rust Backend
  |-- ConPTY / openpty --> Claude Code CLI
  |-- TAP TCP socket <-- Inspector events
  |-- API proxy --> Provider routing
  |-- WinRT toast notifications
```

Built with [Tauri v2](https://tauri.app), [xterm.js 6](https://xtermjs.org), [Zustand](https://github.com/pmndrs/zustand), and [React 19](https://react.dev).

## License

MIT
