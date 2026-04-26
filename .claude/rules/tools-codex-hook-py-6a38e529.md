---
paths:
  - "tools/codex_hook.py"
---

# tools/codex_hook.py

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex hooks for proofd via Python
Codex doesn't auto-load Claude-style path-scoped Markdown rules. Python codex_hook.py is wired through Codex's SessionStart and UserPromptSubmit hooks (.codex/hooks.json) gated by features.codex_hooks=true (.codex/config.toml). Emits hookSpecificOutput.additionalContext with proofd guidance + scoped context lookup.

- [CK-01 L2] Codex SessionStart and UserPromptSubmit hook entrypoints live in tools/codex_hook.py. SessionStart event emits a single 'Agent Proofs' guidance block (proofd commands + repo status from proofd status). UserPromptSubmit event extracts file-path candidates from the prompt via PATH_RE (rejects URLs); also matches PROOF_PROMPT_RE (proofd|proof|prove|rules?|tags?|review|janitor|/r|/j|/rj) to fall back to git diff HEAD --name-only when no paths in prompt. Runs proofd context <paths...> via subprocess (15s/20s timeouts) and emits the result as additionalContext (truncated at MAX_CONTEXT_CHARS=12000 with '[proofd context truncated]' suffix). hookSpecificOutput envelope: {hookEventName, additionalContext}. .codex/hooks.json wires the script via 'python "$(git rev-parse --show-toplevel)/tools/codex_hook.py" {event}' command. .codex/config.toml sets features.codex_hooks=true to opt-in.
  - tools/codex_hook.py:L1 (entrypoint), tools/codex_hook.py:L94 (prompt_paths), tools/codex_hook.py:L129 (session_context), tools/codex_hook.py:L164 (prompt_context), .codex/hooks.json:L1 (hook wiring), .codex/config.toml:L1 (feature flag)
