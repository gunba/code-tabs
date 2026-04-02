# Claude Tabs

Tauri v2 desktop app managing multiple Claude Code CLI sessions in tabs. Rust backend + React/TypeScript frontend. No API key — uses the Claude Code CLI directly.

The Claude Code source itself (4/1/2026) is available here [C:\Users\jorda\PycharmProjects\claude_tabs] if you need to determine the internal behaviour of the embedded application.

# Workflow

The user launches with `claude -w` for isolated worktrees. A SessionStart hook automatically sets up shared build dependencies. Do NOT call EnterWorktree — the user has already done this.

The user will run `/r`, `/j`, `/b` when ready. Do not run these automatically.

# Planning

When in plan mode, after you have drafted your plan but before presenting it to the user: spawn the `plan_agents` from `.proofs/config.json`, passing your draft plan. Incorporate the feedback into the final plan, then present to the user.

Do NOT use TaskOutput to poll. Wait for task-notifications.

# Documentation

All tagged documentation lives in `.claude/rules/`. Each rule file has `paths:` YAML frontmatter for auto-loading by Claude Code. Global rules (no `paths:`) load for all conversations.

Key rule files:
- `project-conventions.md` — architecture, build commands, slash commands, layout (global)
- `dev-rules.md` — development conventions: IPC, types, stores, components, testing, logging (global)
- `project-structure.md` — frontend file tree (global)
- `philosophy.md` — documentation system design principles (global)
- Feature-specific rules are path-scoped and auto-load when relevant files are mentioned

Tags are embedded in source code as `// [TAG] brief description` comments at implementation sites. The prover verifies these anchors during `/j` runs.

The prove pipeline uses `rule_dirs` glob in `.proofs/config.json` for auto-discovery — no need to manually register new rule files.
