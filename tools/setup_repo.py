#!/usr/bin/env python3
"""
Bootstrap a repository for the external agent-proofs/proofd workflow.

This script intentionally makes only low-risk repo-local changes:
- initializes proofd state for the repo
- optionally imports legacy `.proofs` / `.claude/rules`
- updates repo-local Claude settings for worktree rule symlinks
- writes a CLAUDE.md snippet file for manual merge into the project instructions
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
PROOFD_PATH = SCRIPT_DIR / "proofd.py"
INSTALL_BIN = "$HOME/.claude/agent-proofs/bin"

CLAUDE_SNIPPET_TEMPLATE = """# Workflow

Use `/r`, `/j`, `/b`, `/c`, and `/rj` from this repo root.

When review is delegated to Codex in `/r` or `/rj`, the same rule applies: if the review subprocess runs in the background, you must remain blocked on the task-notification before continuing. Do not present a final review result, do not begin janitor or finalization work that depends on the review, and do not treat the review as optional. It is normal for a Codex review wait to take up to 30 minutes.

For long-running Bash commands such as Codex delegates or builds, launch them with `run_in_background: true`.
The immediate launch response only means the task started; it is not completion, and the timeout is only an upper bound on how long the subprocess may run.
Do NOT use TaskOutput to poll. Wait for task-notifications, then read the referenced `<output-file>` if you need the completed command output. If the background result is required to complete the current workflow step, remain blocked on that notification instead of concluding the step early.

# Documentation

All tagged documentation is managed by `proofd`. Canonical rule data lives outside the repo in the proofd knowledge base. `.claude/rules/` is generated output for Claude Code auto-loading.

Do not hand-edit `.claude/rules/*.md`. They are refreshed by `proofd sync`, typically during janitor, build, release, or finalization work. Use `{proofd_cmd}` subcommands to create rules, add entries, split rules, record verifications, and regenerate the rule output.
Generated rule markdown is file-scoped and intentionally omits stored file lists. If you need source-reference files for a tag, use `{proofd_cmd} entry-files --tag <TAG>`.

Tags are embedded in source code as language-appropriate comments containing `[TAG]` near the implementation site. Tags must be allocated by `proofd`; agents must not invent tag IDs themselves.

Useful commands:
- `{proofd_cmd} sync`
- `{proofd_cmd} lint`
- `{proofd_cmd} entry-files --tag <TAG>`
- `{proofd_cmd} select-matching <paths...>`
- `{codex_delegate_cmd} <workflow> ...`
"""


def child_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def installed_script_command(name: str) -> str:
    path = f"{INSTALL_BIN}/{name}.py"
    if os.name == "nt":
        return f'python "{path}"'
    return f'"{path}"'


def build_claude_snippet() -> str:
    return CLAUDE_SNIPPET_TEMPLATE.format(
        proofd_cmd=installed_script_command("proofd"),
        codex_delegate_cmd=installed_script_command("codex_delegate"),
    )


def repo_root_from(path: pathlib.Path) -> pathlib.Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=str(path),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError("setup_repo.py must be run inside a git repository")
    return pathlib.Path(result.stdout.strip()).resolve()


def run_proofd(repo_root: pathlib.Path, args: list[str]) -> str:
    result = subprocess.run(
        [sys.executable, str(PROOFD_PATH), "--repo-root", str(repo_root), *args],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"proofd {' '.join(args)} failed")
    return result.stdout


def ensure_gitignore(repo_root: pathlib.Path) -> list[str]:
    return []


def session_start_sync_hook() -> dict[str, object]:
    return {
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": f'{installed_script_command("proofd")} sync >/dev/null 2>&1 || echo \'{{"systemMessage":"proofd sync failed on session start; run proofd sync manually."}}\'',
                "timeout": 60,
                "statusMessage": "Syncing proofd rules...",
            }
        ],
    }


def ensure_repo_settings(repo_root: pathlib.Path) -> tuple[bool, bool]:
    path = repo_root / ".claude" / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    settings = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    desired_command = session_start_sync_hook()["hooks"][0]["command"]
    removed_hook = False

    hooks = settings.get("hooks")
    if isinstance(hooks, dict):
        groups = hooks.get("SessionStart", [])
        if isinstance(groups, list):
            filtered_groups = []
            for group in groups:
                group_hooks = group.get("hooks", []) if isinstance(group, dict) else []
                if any(
                    isinstance(hook, dict)
                    and hook.get("type") == "command"
                    and hook.get("command") == desired_command
                    for hook in group_hooks
                ):
                    removed_hook = True
                    continue
                filtered_groups.append(group)
            if filtered_groups:
                hooks["SessionStart"] = filtered_groups
            elif "SessionStart" in hooks:
                del hooks["SessionStart"]
        if not hooks:
            settings.pop("hooks", None)

    worktree = settings.setdefault("worktree", {})
    symlink_directories = worktree.setdefault("symlinkDirectories", [])
    updated_symlink = False
    if ".claude/rules" not in symlink_directories:
        symlink_directories.append(".claude/rules")
        updated_symlink = True

    path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    return updated_symlink, removed_hook


def write_claude_snippet(repo_root: pathlib.Path) -> pathlib.Path:
    target = repo_root / ".claude" / "agent-proofs-CLAUDE-snippet.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(build_claude_snippet().rstrip() + "\n", encoding="utf-8")
    return target


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bootstrap a repo for agent-proofs")
    parser.add_argument("--repo-root", default=".")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init")
    init_parser.add_argument("--import-legacy", action="store_true")
    init_parser.add_argument("--legacy-rules-dir", default=".claude/rules")
    init_parser.add_argument("--legacy-proofs-dir", default=".proofs")
    init_parser.add_argument("--skip-gitignore", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    repo_root = repo_root_from(pathlib.Path(args.repo_root).resolve())

    gitignore_updates: list[str] = []
    if not args.skip_gitignore:
        gitignore_updates = ensure_gitignore(repo_root)
    symlink_updated, removed_hook = ensure_repo_settings(repo_root)

    if args.import_legacy:
        run_proofd(
            repo_root,
            [
                "import-legacy",
                "--legacy-rules-dir",
                args.legacy_rules_dir,
                "--legacy-proofs-dir",
                args.legacy_proofs_dir,
                "--sync",
            ],
        )
        action = "Imported legacy rules/proofs and generated `.claude/rules`."
    else:
        run_proofd(repo_root, ["init"])
        run_proofd(repo_root, ["sync"])
        action = "Initialized proofd metadata and generated `.claude/rules`."

    snippet_path = write_claude_snippet(repo_root)

    print(f"Repo: {repo_root}")
    print(action)
    if gitignore_updates:
        print(f"Updated .gitignore: {', '.join(gitignore_updates)}")
    if symlink_updated:
        print("Updated .claude/settings.json: added worktree symlinkDirectories entry for .claude/rules.")
    else:
        print(".claude/settings.json already symlinked .claude/rules into new worktrees.")
    if removed_hook:
        print("Removed legacy SessionStart proofd sync hook from .claude/settings.json.")
    print(f"Wrote CLAUDE.md integration snippet: {snippet_path}")
    print("")
    print("Next steps:")
    print("1. Merge the snippet into the repo's CLAUDE.md.")
    print("2. Review generated `.claude/rules/` and run proofd lint.")
    print("3. Decide whether this repo will track the generated `.claude/rules` snapshot and keep that policy consistent.")
    print("4. Start using `/r`, `/j`, `/b`, `/c`, `/rj`, and `proofd` from this repo root.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
