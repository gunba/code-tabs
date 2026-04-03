# Claude Tabs

Tauri v2 desktop app managing multiple Claude Code CLI sessions in tabs. Rust backend + React/TypeScript frontend. No API key — uses the Claude Code CLI directly.

The Claude Code source itself (4/1/2026) is available here [C:\Users\jorda\PycharmProjects\claude_tabs] if you need to determine the internal behaviour of the embedded application.

# Workflow

The user launches with `claude -w` for isolated worktrees. A SessionStart hook automatically sets up shared build dependencies. Do NOT call EnterWorktree — the user has already done this.

The user will run `/r`, `/j`, `/b` when ready. Do not run these automatically.

# Planning

When in plan mode, after you have drafted your plan but before presenting it to the user: ask whether plan critique should run via the Claude `plan-critic` agent, a Codex subprocess, or both.

If Codex is selected, save the draft plan to `plans/` and run `python "$HOME/.claude/agent-proofs/bin/codex_delegate.py" plan --plan-file <path>`. The Codex handoff preloads proofd rule context for plan and review workflows. If more rule detail is needed in a read-only subprocess, prefer direct reads of `CLAUDE.md` and relevant `.claude/rules/*.md` files or use `proofd` MCP only when it is already configured.

If Claude is selected, spawn the `plan-critic` agent, passing the draft plan. Incorporate the feedback into the final plan, then present to the user.

Do NOT use TaskOutput to poll. Wait for task-notifications.

# Documentation

All tagged documentation is managed by `proofd`. Canonical rule data lives outside the repo in the proofd knowledge base. `.claude/rules/` is generated output for Claude Code auto-loading.

Do not hand-edit `.claude/rules/*.md`. Use `python "$HOME/.claude/agent-proofs/bin/proofd.py"` subcommands to create rules, add entries, split rules, record verifications, and regenerate the rule output.

`python "$HOME/.claude/agent-proofs/bin/proofd.py" sync` regenerates local `.claude/rules/*.md` files on disk. Those files are generated, gitignored, and disposable. Their absence from `git status` is expected; the canonical proof update lives in the external proofd KB plus any source tag comments or code changes in the repo.

Key rule files:
- `project-conventions.md` — architecture, build commands, slash commands, layout (global)
- `dev-rules.md` — development conventions: IPC, types, stores, components, testing, logging (global)
- `project-structure.md` — frontend file tree (global)
- `philosophy.md` — documentation system design principles (global)
- Feature-specific rules are path-scoped and auto-load when relevant files are mentioned

Tags are embedded in source code as `// [TAG] brief description` comments at implementation sites. Tags must be allocated by `proofd`; agents must not invent tag IDs themselves.

Useful commands:
- `python "$HOME/.claude/agent-proofs/bin/proofd.py" import-legacy --sync` — import the old rules/proofs once and generate current rule markdown
- `python "$HOME/.claude/agent-proofs/bin/proofd.py" sync` — regenerate `.claude/rules`
- `python "$HOME/.claude/agent-proofs/bin/proofd.py" lint` — audit rules, anchors, and auto-load coverage
- `python "$HOME/.claude/agent-proofs/bin/proofd.py" select-matching <paths...>` — select likely relevant entries for proving
- `python "$HOME/.claude/agent-proofs/bin/codex_delegate.py" <workflow> ...` — run a Codex subprocess for review, janitor, build, combined `/rj`, or plan critique
