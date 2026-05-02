---
paths:
  - "src/hooks/tapCodexNaming.ts"
---

# src/hooks/tapCodexNaming.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-23 L54] Codex tabs auto-rename via LLM upgrade after heuristic word-truncation: on first accepted UserInput for a Codex session, maybeAutoNameCodexSession only renames tabs whose current name is empty, generic ('run'/'codex'/'new session'), or matches a default tab-name candidate derived from either workingDir or launchWorkingDir. It applies deriveCodexPromptTitle (7-word truncation, 54-char cap), persists the heuristic to the session store and sessionNames map via getResumeId, then fire-and-forget invokes generate_codex_session_title through Tauri using settings.codexAutoRenameLLMModel (default gpt-5-mini) when codexAutoRenameLLMEnabled is true. The LLM result replaces the heuristic only while session.name still equals that heuristic, preserving manual mid-flight renames; codexLLMUpgraded prevents duplicate exec spawns. Fresh launcher session configs stamp launchWorkingDir from workingDir so new Codex tabs do not inherit stale launcher cwd defaults. Sibling to SL-18 (Claude CustomTitle): tab naming is a Code Tabs concept, not a PTY-injected Codex command.
  - Sources: src/hooks/tapCodexNaming.ts createTapCodexNaming/maybeAutoNameCodexSession; src/lib/codexNaming.ts deriveCodexPromptTitle/codexDefaultTabNameCandidates/isAutoNameableCodexName; src/lib/sessionLauncherConfig.ts buildFinalLauncherConfig; tests in src/hooks/__tests__/tapCodexNaming.test.ts, src/lib/__tests__/codexNaming.test.ts, and src/lib/__tests__/sessionLauncherConfig.test.ts cover stale launchWorkingDir, LLM upgrade/manual guard, default-name candidates, and launch config stamping.
