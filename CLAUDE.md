# Claude Tabs — Development Guide

## MANDATORY: Test Every Change

You MUST personally test every change using the test harness before delivering. Do NOT guess at fixes or theorize about root causes without evidence. The workflow is:

1. Add logging/instrumentation to observe the actual behavior
2. Launch the app and reproduce the issue using the test bridge
3. Read the logs/state to understand what's actually happening
4. Make a targeted fix based on observed evidence
5. Re-run the same reproduction test to verify the fix works
6. Only then commit and deliver

If the test harness can't reproduce an issue, EXTEND IT until it can. Never say "I can't test this" — build the capability first.

## What is this?

A Tauri v2 desktop app that manages multiple Claude Code CLI sessions in tabs. Built with Rust backend + React/TypeScript frontend. No API key required — uses the Claude Code CLI directly.

## Quick Commands

```bash
npm run tauri dev      # Run in dev mode (hot-reload)
npm run tauri build    # Build NSIS installer
npx tsc --noEmit       # Type-check only
npm test               # Run unit tests (vitest)
node scripts/e2e-test.cjs  # Full E2E self-test (build first)
```

## Documentation

| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file — conventions and rules for agents |
| `docs/ARCHITECTURE.md` | System design, data flow, component architecture |
| `docs/STATUS.md` | Current project state — what's done, pending, known issues |
| `docs/SELF-TEST.md` | Agent self-testing protocol |
| `docs/TESTING.md` | Manual test checklist |

## Architecture

```
React UI (WebView2) ←→ Tauri IPC ←→ Rust Backend ←→ ConPTY ←→ Claude CLI
```

**Layout**: Terminal-first. Tab bar → Subagent bar → [Terminal | ActivityFeed] → CommandBar → StatusBar.

- **PTY**: `tauri-plugin-pty` (Rust) + `tauri-pty` npm. Do NOT pass `env: {}` — omit to inherit.
- **State detection**: JSONL-based. Rust watcher tails `~/.claude/projects/{dir}/{session}.jsonl`. PTY is display-only (permission scan only).
- **Persistence**: Sessions → `%LOCALAPPDATA%/claude-tabs/sessions.json` (frontend-owned). Settings → `localStorage`.
- **Discovery**: CLI options from `claude --help`. Slash commands from binary scan + plugin/skill file scan. Hooks from settings files.
- **Haiku summariser**: `useMetaAgent()` hook, one-shot pipe mode, 15s debounce.

## Validation — REQUIRED before every delivery

```bash
npx tsc --noEmit           # Zero TypeScript errors
npm test                   # All Vitest tests pass
cargo check (in src-tauri) # Zero Rust errors
node scripts/e2e-test.cjs  # 20+ E2E checks pass (launches app, verifies state)
```

The E2E test is the primary verification tool. It launches the built exe, reads app state from the test harness (`test-state.json`), and verifies initialization, session persistence, CLI discovery, slash commands, and hooks. See `docs/SELF-TEST.md`.

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

### Things that broke before (don't repeat)
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

### Subagent Delegation
Delegate independent work to subagents. Farm out file creation, test writing, and documentation updates to parallel agents.

## Testing

### Unit Tests (67 across 6 files)
- `jsonlState` 31, `claude` 14, `deadSession` 10, `metaAgent` 5, `theme` 4, `ptyRegistry` 3

### E2E Self-Test (20+ checks)
```bash
node scripts/e2e-test.cjs
```
Launches the app, reads test harness state, verifies everything. See `docs/SELF-TEST.md`.
