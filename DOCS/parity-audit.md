# Claude ↔ Codex parity audit

Walk every user-visible Claude Code surface and confirm one of:
- ✅ Codex sibling working (cite the file/function that delivers it)
- ⚠️ Codex sibling partial (works but loses something — note what)
- ⛔ No analog (deferred or won't-do — note why)

Audit run: 2026-04-25 (batches 1–9 landed).

## Spawn surface

| Claude | Codex | Status |
|---|---|---|
| `detect_claude_cli_sync` (5-step PATH chain) | `detect_codex_cli_sync` (env override → `which` → fallbacks) | ✅ |
| `build_claude_args(SessionConfig)` | `CodexAdapter::build_spawn` translates `SessionConfig` → Codex flags | ✅ |
| `claude --resume <id>` | `codex resume <id>` subcommand | ✅ |
| `claude --continue` | `codex resume --last` | ✅ |
| `claude --fork-session <id>` | `codex fork <id>` | ✅ |
| `--system-prompt` / `--append-system-prompt` flags | `[instructions]` / `[developer_instructions]` config keys | ⚠️ — Claude has flags; Codex requires editing config.toml. Settings tab does not yet wire those keys. |
| `--mcp-config <path>` | MCP servers come from `~/.codex/config.toml` `[mcp_servers]` only | ⚠️ — no per-session `--mcp-config` equivalent on Codex |
| `--allowedTools` / `--disallowedTools` | Codex has no analog; relies on sandbox + approval policy | ⛔ no analog |
| `--max-budget-usd` | Codex has no analog | ⛔ no analog |
| `BUN_INSPECT` env injection | `codex` is Rust; no inspector | ⛔ N/A — observability via rollout file |

## Discovery

| Claude | Codex | Status |
|---|---|---|
| Models (`ANTHROPIC_MODELS` constant) | `discover_codex_models` runs `codex debug models` (returns full JSON catalog) | ✅ |
| Effort levels (`ANTHROPIC_EFFORTS`) | Per-model `supported_reasoning_levels` from `codex debug models` | ✅ |
| Slash commands (binary scan) | Vendored 26-entry catalog in `codex_cli.rs::CODEX_SLASH_COMMANDS` (Codex doesn't expose slash commands via CLI; documented in source) | ⚠️ vendored — last verified against `codex-rs/tui/src/slash_command.rs` |
| Plugin commands (`~/.claude/plugins/`) | No analog — Codex has skills, not plugins | ⛔ no analog |
| Skills (`SKILL.md` scan) | `discover_codex_skills` — same scanner, Codex roots (`~/.agents/skills/`, `<repo>/.codex/skills/`, `<repo>/.agents/skills/`, `~/.codex/skills/`) | ✅ |
| Settings schema (binary Zod scan) | No analog — Codex config schema not exposed via CLI | ⛔ Settings tab is Claude-only. Codex users edit `~/.codex/config.toml` directly. Documented in batch 9 follow-up. |
| Env vars (binary scan + catalog) | `codex --help` parsing surfaces flag-tied env hints | ⚠️ partial |
| CLI option pills (`claude --help`) | `discover_codex_cli_options` parses `codex --help` regex | ✅ |
| Feature flags | `discover_codex_features` runs `codex features list` | ✅ |

## Observability

| Claude | Codex | Status |
|---|---|---|
| Bun inspector + TAP TCP server | Tail `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` via `notify` watcher | ✅ |
| Anthropic SSE stream parsing (`tapClassifier.ts`) | `RolloutItem` JSONL parsing in `observability/codex_rollout.rs` | ✅ |
| `event_msg.token_count` (input/cached/output/reasoning) | Identical fields in `TokenUsageBreakdown`; richer (`reasoning_output_tokens`) | ✅ |
| Tool call start/complete | `response_item.function_call` / `function_call_output` | ✅ |
| Subagent events | Codex has no Task-tool equivalent in the rollout | ⛔ no analog |
| Session compaction | `compacted` rollout item | ✅ |
| `traffic.jsonl` (proxy) | Claude only — Codex doesn't go through the proxy | ⛔ N/A |
| Status bar token totals (per-tab) | Wire from `codex.token_count` events | ⚠️ events emitted to `observability.jsonl`; status-bar accumulator is still Claude-only. Follow-up: extend `tapMetadataAccumulator` to read `codex.*` events. |

## UI surfaces

| Claude | Codex | Status |
|---|---|---|
| Per-tab CLI chip in status bar | ✅ chip with color (orange/teal) | ✅ |
| Tab strip color stripe | ✅ 3px left edge | ✅ |
| Launcher CLI pill | ✅ "Claude Code" / "Codex" pills above model picker | ✅ |
| Launcher model picker | Driven by `cli_launch_options(active.cli)` | ✅ |
| Launcher effort picker | Driven by adapter's effort_levels (Claude: 5 levels; Codex: 4) | ✅ |
| Launcher CLI option pills | Adapter-driven; Codex pills come from `discover_codex_cli_options` | ✅ |
| Settings tab | Claude-only schema | ⚠️ — Settings tab still scopes to Claude; Codex tabs render the same view. Acceptable for now; would need a vendored Codex schema to fix. |
| Hooks tab | Claude `settings.json[hooks]` only | ⚠️ — Codex hook config not surfaced in UI yet (lives in `config.toml`). |
| MCP tab | Claude `settings.json[mcpServers]` | ⚠️ — Codex MCP servers can be ported via Port content pane but the live MCP tab is still Claude-only. |
| Skills editor | Claude `~/.claude/skills` and `<proj>/.claude/skills/` | ⚠️ — Codex skills appear in command palette but not in the dedicated Skills editor UI. |
| Plugins tab | Claude only | ⛔ no analog (Codex has no plugins) |
| Prompts tab (system-prompt rewrite rules) | Claude only — applied by the slimmed proxy | ⛔ Codex tabs bypass the proxy; Codex equivalent is `[instructions]`/`[developer_instructions]` config keys (deferred Settings tab wiring). |
| Command palette built-ins | Claude binary scan + Codex vendored catalog merged | ✅ |
| Command palette skills | `discover_plugin_commands` + `discover_codex_skills` merged | ✅ |
| Recording / Observability tab | Reads `observability.jsonl` (CLI-agnostic sink) | ✅ — both CLIs land here |
| Port content tab | Three pairs (Skill, Memory, MCP) with backup tarball | ✅ |
| Worktree tab grouping | `parseWorktreePath()` matches `.claude/worktrees/<slug>` | ⚠️ — still Claude-named directory used for both CLIs. Plan calls for `.claude_tabs/worktrees/`; not migrated yet. Document and follow up. |

## Login / auth

| Claude | Codex | Status |
|---|---|---|
| `claude login` (CLI-managed) | `codex login` (CLI-managed) | ✅ — both delegated to the CLI; no in-app modal for either |

## Port content (`.claude/` ↔ `.codex/`)

| Pair | Status |
|---|---|
| Skill directory copy | ✅ |
| `CLAUDE.md` ↔ `AGENTS.md` (copy or symlink) | ✅ |
| MCP servers (JSON ↔ TOML) | ✅ |
| Hooks translation | ⛔ deferred — translator table needs Codex hook event-name lock-in |
| `.claude/commands/*.md` → Codex skill | ⛔ deferred — best-effort wrapper script worth its own batch |

## Open follow-ups (next batch beyond 9)

1. **Status bar / activity panel for Codex tabs.** Extend `tapMetadataAccumulator` to read the `codex.token_count` and `codex.tool_call_*` events from `observability.jsonl` so status-bar token totals and current-action chips populate for Codex tabs.
2. **Worktree dir rename.** Migrate `.claude/worktrees/` → `.claude_tabs/worktrees/`. Parser updates + new-worktree default + per-project legacy-location banner.
3. **Settings/Hooks/MCP tabs Codex-aware.** Header chip naming the file being edited; per-row CLI source badge in MCP and Hooks lists; Codex-aware schema for `[instructions]`, `[developer_instructions]`, `[hooks]` keys.
4. **Skills editor unified view.** `list_codex_skills` results merged into the SkillsEditor pane with a target-CLI badge on each row; "copy to other side" action.
5. **Hooks port.** Translator table from Claude `settings.json[hooks]` → Codex `config.toml[[hooks.*]]`. Locked event-name table sourced from `codex-rs/config/src/hook_config.rs:16-29` (PreToolUse, PermissionRequest, PostToolUse, SessionStart, UserPromptSubmit, Stop — same set).
6. **Slash-command-to-skill converter.** Best-effort `.claude/commands/foo.md` → `.codex/skills/foo/SKILL.md` with frontmatter wrapping.
7. **De-Claude-ify rules files.** `.claude/rules/*.md` files reference Claude-only behavior in tag lines; the externally-generated regeneration pass needs to either widen to both CLIs or split into `claude/` and `codex/` subdirs.

## Test status (end of batch 9)

- 139 Rust tests
- 1076 TS tests (6 pending, 0 failed)
- `cargo check` and `tsc --noEmit` clean
