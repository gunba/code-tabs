# proofd

`proofd` replaces the old repo-local `.proofs` pipeline with:

- A companion knowledge base repo outside the code repo for canonical structured rules
- A local SQLite DB for verification history, citations, run logs, and branch overlays
- Generated `.claude/rules/*.md` for Claude Code auto-loading

The goal is to preserve automatic context injection while removing merge-heavy proof state from the code repo.

## Key Properties

- Agents do not invent tags. They obtain tags only by calling `proofd` mutation commands.
- Rule markdown is generated output, not the source of truth.
- Branch/worktree mutations live in a local overlay until promoted.
- Source-code tag anchors such as `// [CI-01] ...` remain first-class and are linted.
- Global rules are allowed, but should stay concise.

## Storage

Defaults on Windows:

- Knowledge base root: `%USERPROFILE%\\.proofd\\kb`
- State DB: `%LOCALAPPDATA%\\proofd\\state.db`

Per repo, `proofd` stores:

- Canonical rule JSON in `kb/repos/<repo-id>/rules/*.json`
- Repo metadata in `kb/repos/<repo-id>/repo.json`
- Branch overlays in `%LOCALAPPDATA%\\proofd\\overlays\\<repo-id>\\<branch>\\rules/*.json`

The code repo only receives generated `.claude/rules/*.md`.

For cross-machine use:

- share or git-sync the KB root
- keep `state.db` local to each machine
- let each machine regenerate `.claude/rules/` locally

`repo_id` now defaults to a stable digest of the normalized `remote.origin.url`, so the same repo can resolve to the same KB identity on Windows and Linux. If a repo has no stable origin remote, use `--repo-key <stable-id>` or `PROOFD_REPO_KEY=<stable-id>`.

## CLI

Initialize and inspect:

```powershell
python tools/proofd.py init
python tools/proofd.py status
```

`proofd` will automatically migrate older path-hash repo IDs in the KB or local state DB to the new stable identity when it can do so safely.

Import the old rules/proofs once:

```powershell
python tools/proofd.py import-legacy --sync
```

Generate and audit:

```powershell
python tools/proofd.py sync
python tools/proofd.py lint
python tools/proofd.py context src/components/ConfigManager/ConfigManager.tsx
python tools/proofd.py entry-files --tag CI-01
```

Mutate rules without editing markdown:

```powershell
python tools/proofd.py create-rule --title "Foo" --paths "src/foo/**"
python tools/proofd.py add-entry --rule foo --statement "Foo does bar" --files "src/foo/index.ts"
python tools/proofd.py update-entry --tag FO-01 --statement "Updated text"
python tools/proofd.py entry-files --tag FO-01
python tools/proofd.py delete-entry --tag FO-02
python tools/proofd.py split-rule --rule foo --new-title "Foo Advanced" --tags FO-03,FO-04
python tools/proofd.py record-verification --tag FO-01 --status confirmed --files "src/foo/index.ts"
python tools/proofd.py promote-overlay
```

## Generated Rules

`proofd sync` renders each structured rule as a concise markdown file with optional `paths:` YAML frontmatter so Claude Code auto-loads the right rules when files are touched.

Generated rule files include:

- Rule title
- Stable tag statements

They intentionally omit verification telemetry, `Files:` lines, and long historical notes. Query anchors on demand with `proofd entry-files --tag <TAG>`.

## MCP

Run the minimal local MCP server:

```powershell
python tools/proofd.py mcp
```

Current tools:

- `proofd_context`
- `proofd_entry_files`
- `proofd_create_rule`
- `proofd_add_entry`
- `proofd_update_entry`
- `proofd_delete_entry`
- `proofd_record_verification`
- `proofd_sync`
- `proofd_lint`

## Suggested Workflow

1. Import once from the legacy `.proofs` and `.claude/rules`.
2. Stop editing rule markdown directly.
3. Let agents create/update rules through `proofd`.
4. Run `proofd sync` whenever rule state changes.
5. Promote branch overlays when the code branch is ready to merge.

## Notes

- `proofd lint` warnings are intentionally advisory. Large projects may legitimately surface many rules.
- Splitting is supported even when multiple rule files share the same source-file scope. This is the main escape hatch for large single-feature rule sets.
- If an entry refers to deleted code, remove it with `proofd delete-entry` instead of leaving it as a permanent lint warning.
