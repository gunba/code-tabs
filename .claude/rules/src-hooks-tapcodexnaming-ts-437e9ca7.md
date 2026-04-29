---
paths:
  - "src/hooks/tapCodexNaming.ts"
---

# src/hooks/tapCodexNaming.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-23 L59] Codex tabs auto-rename via LLM upgrade after the heuristic word-truncation: on first UserInput event, after maybeAutoNameCodexSession applies a fast heuristic title (deriveCodexPromptTitle → 7-word truncation, 54-char cap), useTapEventProcessor fire-and-forget invokes generate_codex_session_title via Tauri (spawning 'codex exec --model gpt-5-mini' by default, configurable per codexAutoRenameLLMModel setting). On resolve, the LLM result replaces the tab name only if session.name still equals the heuristicTitle — manual user renames mid-flight are respected. codexLLMUpgraded Set<string> prevents a second exec spawn for the same session. Toggle: settings.codexAutoRenameLLMEnabled (default true, opt-out via Code Tabs preferences section in SettingsTab when cli==='codex'). codexAutoRenameLLMModel default 'gpt-5-mini' — free-text input since Codex accepts any model string at runtime. Sibling to SL-18 (Claude's CustomTitle) — no Op::SetThreadName round-trip into Codex (tab name is a Code Tabs concept; PTY injection would surface as TUI noise in the user's session).
