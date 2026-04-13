---
paths:
  - "src/components/SessionLauncher/SessionLauncher.tsx"
---

# src/components/SessionLauncher/SessionLauncher.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-11 L30] CLI option pills: flags from `claude --help` shown as clickable pills; flags with dedicated UI controls (model, permissions, effort, etc.) are excluded from the grid
- [SL-14 L37] Non-session flags (`--version`, `--help`, `--print`, etc.): rendered in separate Utility Commands section (collapsed by default) with muted styling; selecting them changes Launch button to "Run" (blue) and removes the working directory requirement
- [SL-01 L48] Modal for new session or resume — Ctrl+T opens fresh (clears resume/continue flags)
- [SL-09 L49] Config restore: SessionLauncher uses savedDefaults (explicit "Save defaults") with lastConfig fallback, clearing one-shot fields (continueSession, sessionId, runMode); resume fields preserved from lastConfig when set by configure flow
- [SL-21 L142] Workspace-specific launch defaults: setSavedDefaults writes per-workspace entry into workspaceDefaults map (keyed by lowercased project root, worktree paths collapsed); SessionLauncher layers matching workspace defaults on mount and when switching workspace via browse or recent chip; no-entry workspace resets to global savedDefaults/lastConfig baseline; forkSession:false and other transient fields excluded from workspace entry
- [SL-12 L234] Active flag indicators: pills highlight with accent color when their flag is present in the command line (reactive to manual edits in textarea)
- [SL-10 L257] CLI command pills sorted by usage frequency (same heat gradient as Command Bar)
- [SL-19 L304] Directory validation: before launching, SessionLauncher invokes dir_exists (Rust command) to confirm the working directory exists; shows 'Directory does not exist' error inline and blocks launch if not found

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-02 L312] OpenAI Codex is exposed as a predefined openai_codex provider with canonical primary/small models, 272k context mappings, and persisted-config migration backfills; ProvidersPane shows OAuth login/logout state, SessionLauncher blocks non-utility Codex launches until auth is available, and the Rust adapter translates Anthropic-style requests and streaming responses through the OpenAI Responses API.
