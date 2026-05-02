---
paths:
  - "tools/codex_hook.py"
---

# tools/codex_hook.py

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex hooks for proofd via Python
Codex doesn't auto-load Claude-style path-scoped Markdown rules. Python codex_hook.py is wired through Codex's SessionStart and UserPromptSubmit hooks (.codex/hooks.json) gated by features.codex_hooks=true (.codex/config.toml). Emits hookSpecificOutput.additionalContext with proofd guidance + scoped context lookup.

- [CK-01 L2] Codex SessionStart and UserPromptSubmit hook entrypoints live in tools/codex_hook.py. SessionStart emits a single "Agent Proofs" guidance block with proofd commands and repo status from proofd status. UserPromptSubmit extracts explicit file-path candidates from the prompt via PATH_RE, rejects URLs, and only requests proofd context when the prompt names existing repo paths; review/janitor slash commands such as /r, /j, and /rj do not trigger diff-wide automatic context injection. Runs proofd context <paths...> via subprocess and emits the result as hookSpecificOutput.additionalContext, truncated at MAX_CONTEXT_CHARS=12000 with "[proofd context truncated]" suffix. hookSpecificOutput envelope: {hookEventName, additionalContext}. .codex/hooks.json wires the script via `python "$(git rev-parse --show-toplevel)/tools/codex_hook.py" {event}` command. .codex/config.toml sets features.codex_hooks=true to opt in.
  - tools/codex_hook.py:L1 (entrypoint), tools/codex_hook.py:L87 (prompt_paths), tools/codex_hook.py:L122 (session_context), tools/codex_hook.py:L157 (prompt_context), .codex/hooks.json:L1 (hook wiring), .codex/config.toml:L1 (feature flag)
