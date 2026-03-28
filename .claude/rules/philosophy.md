# Philosophy

<!-- Codes: PH=Philosophy -->

Design principles for the agent proofs system.

- [PH-01] Living documentation: every claim about the codebase is tagged, periodically proved against the source, and its accuracy recorded. Documentation that is not verified decays.

- [PH-02] Agent specialization: a reviewer reads but does not write. A prover verifies docs but does not change code. Separation of concerns prevents conflicts and makes each agent's output auditable.

- [PH-03] Democratised voting: every tagged entry earns citations through use. When an agent references an entry during work, the entry's `seen` count increments. When the entry is useful (confirms behavior, guides a decision), it gets upvoted. Entries never cited across many runs are candidates for removal.

- [PH-04] No privileged entries: the architecture diagram, the file tree, the build commands, and the pixel-level CSS rules all have tags and all face the same prove cycle. There is no second-class documentation.

- [PH-05] Citation ratio measures utility: upvotes divided by seen count. An entry with 0 upvotes across 10 runs is likely dead documentation. An entry with 8/10 is load-bearing. The system self-corrects over time.

- [PH-06] Worktree isolation: each task gets its own git worktree. Review, prove, and feature work happen in isolation. Agents within a worktree can work concurrently because their tool access is constrained by frontmatter — not by hooks that can be worked around.

- [PH-07] Natural release pipeline: work flows through worktrees to the main branch via merge. Each merge is a commit. The commit history tells the story: code change → review → prove → release. This is the natural pipeline, not a forced process.

- [PH-08] Shared dependencies: build artifacts are shared across worktrees via symlinks/junctions. The `.worktree-deps` config is generic and project-agnostic. A Rust project shares target/. A Node project shares node_modules/. The mechanism is the same.

- [PH-09] Prove cycle: scope-aware proving. `/j` uses `prove.sh select-matching` to prove all tags in rule files whose `paths:` frontmatter matches changed files. Global rules (no paths) always included. Full coverage tied to what actually changed.

- [PH-10] Separation of concerns: commands (workflows) in `~/.claude/commands/`. Agents (roles with tool constraints) in `~/.claude/agents/`. Scripts (atomic operations with input validation) in `$LOCALAPPDATA/claude-agent-logs/bin/`. Hooks (invariant enforcement) in `.claude/settings.local.json`. Prove state (verification history) in `.proofs/`. None overlap in responsibility.
