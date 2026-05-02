---
paths:
  - "src/components/SessionLauncher/SessionLauncher.tsx"
---

# src/components/SessionLauncher/SessionLauncher.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Dual-CLI Session Launcher

- [DU-01 L133] availableCliKinds gates installed Claude/Codex launch choices; buildFullCommand previews Codex resume/fork subcommands, Codex sandbox/approval/effort flags, and Claude --resume/--continue with boolean --fork-session modifiers.
  - SessionLauncher maps Codex resumeSession to either `codex resume <id>` or `codex fork <id>` depending on forkSession. For Claude it previews --resume <id> --fork-session or --continue --fork-session, with permissionMode/effort flags mirroring Rust adapter behavior.

## Codex CLI Adapter

- [CC-08 L61] CODEX_EFFORT_VALUES enum gate: codex.rs:CODEX_EFFORT_VALUES = ["none","minimal","low","medium","high","xhigh"] mirrors the model_reasoning_effort enum in the bundled ConfigToml schema (src-tauri/src/discovery/codex_schema.json model_reasoning_effort#enum). build_spawn skips the -c model_reasoning_effort=... override when the SessionConfig.effort is not in the enum, so a stale Claude-side value such as 'max' (Anthropic effort levels) never reaches Codex's config.toml parser at launch (which would error out). The frontend mirrors the same Set in SessionLauncher.tsx so the displayed CLI command preview matches what build_spawn will actually emit. SessionLauncher additionally clears adapterModels/adapterEfforts synchronously on cli switch (commit cb811e1) so the validator effect drops a stale config.effort/config.model before the new options arrive.

## Launcher CLI Pills

- [SL-11 L52] CLI option pills exclude flags with dedicated UI or session-flow controls: model, permissions, effort, resume/session-id/continue/fork-session, project-dir, Codex sandbox/approval/full-auto, and add-dir.
  - SessionLauncher DEDICATED_FLAGS keeps these flags out of the generic options grid so generated resume/fork/session args come only from structured SessionConfig fields.
- [SL-14 L69] Non-session flags (`--version`, `--help`, `--print`, etc.): rendered in separate Utility Commands section (collapsed by default) with muted styling; selecting them changes Launch button to "Run" (blue) and removes the working directory requirement
- [SL-12 L373] Active flag indicators: pills highlight with accent color when their flag is present in the command line (reactive to manual edits in textarea)
- [SL-10 L401] CLI command pills sorted by usage frequency (same heat gradient as Command Bar)
- [SL-13 L529] Toggle behavior: clicking an active pill removes the flag; clicking an inactive pill adds it
- [SL-15 L542] Utility mode mutual exclusion: clicking a non-session flag or subcommand replaces the entire command line (not toggle-into); session controls disabled and dimmed; clicking the flag again restores; reset button (↺) escapes utility mode
- [SL-16 L874] Subcommand toggle: clicking a subcommand replaces command line with `claude <cmd>`; clicking again resets to generated command

## Session Launcher

- [SL-01 L80] SessionLauncher opens for new, resume, or fork launches; Ctrl+T opens a fresh launcher and clears resumeSession, forkSession, and continueSession from lastConfig.
  - SessionLauncher renders Fork Session/Forking from when config.resumeSession && config.forkSession. The Ctrl+T global shortcut strips all one-shot resume/fork/continue fields before showing the modal.
- [SL-09 L81] SessionLauncher restores config from savedDefaults or lastConfig with workspace-default layering for fresh launches; resume configs bypass workspace defaults, keep forkSession when set, and clear stale continueSession/sessionId/runMode.
  - buildInitialLauncherConfig() uses lastConfig directly when resumeSession is set, preserving fork intent for fork-with-options flows while clearing continueSession, sessionId, and runMode. Fresh launches use savedDefaults/lastConfig plus workspace defaults and force forkSession false.
- [SL-21 L244] Workspace-specific launch defaults: setSavedDefaults writes per-workspace entry into workspaceDefaults map (keyed by lowercased project root, worktree paths collapsed); SessionLauncher layers matching workspace defaults on mount and when switching workspace via browse or recent chip; no-entry workspace resets to global savedDefaults/lastConfig baseline; forkSession:false and other transient fields excluded from workspace entry
- [SL-19 L455] Directory validation: before launching, SessionLauncher invokes dir_exists (Rust command) to confirm the working directory exists; shows 'Directory does not exist' error inline and blocks launch if not found
