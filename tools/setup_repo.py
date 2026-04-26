#!/usr/bin/env python3
"""
Bootstrap a repository for the external agent-proofs/proofd workflow.

This script intentionally makes only low-risk repo-local changes:
- initializes proofd state for the repo
- optionally imports legacy `.proofs` / `.claude/rules`
- updates repo-local Claude settings for worktree rule symlinks
- writes CLAUDE.md and AGENTS.md snippet files for manual merge into project instructions
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
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

For long-running Bash commands such as builds or test suites, launch them with background execution when the runtime supports it.
Do NOT poll background tasks. Wait for completion before acting on dependent results.

# Documentation

All tagged documentation is managed by `proofd`. Canonical rule data lives outside the repo in the proofd knowledge base. `proofd sync` generates Claude Markdown snapshots under `.claude/rules/`.
Codex does not have Claude-style path-scoped rule auto-load, so repo bootstrap configures Codex hooks that inject proofd guidance on session start and targeted proofd context on relevant prompts.

Do not hand-edit `.claude/rules/*.md`. They are refreshed by `proofd sync`, typically during janitor, build, release, or finalization work. Use `{proofd_cmd}` subcommands to create rules, add entries, split rules, record verifications, and regenerate the rule output.
Generated rule markdown is file-scoped and intentionally omits stored file lists. If you need source-reference files for a tag, use `{proofd_cmd} entry-files --tag <TAG>`.

Tags are embedded in source code as language-appropriate comments containing `[TAG]` near the implementation site. Tags must be allocated by `proofd`; agents must not invent tag IDs themselves.

Useful commands:
- `{proofd_cmd} sync`
- `{proofd_cmd} lint`
- `{proofd_cmd} entry-files --tag <TAG>`
- `{proofd_cmd} select-matching <paths...>`
- `{proofd_cmd} context <paths...>`
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


def ensure_codex_hooks_feature(repo_root: pathlib.Path) -> bool:
    path = repo_root / ".codex" / "config.toml"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("[features]\ncodex_hooks = true\n", encoding="utf-8")
        return True

    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    header_re = re.compile(r"^\s*\[([^\]]+)\]\s*$")
    features_index: int | None = None
    next_section = len(lines)
    for index, line in enumerate(lines):
        match = header_re.match(line)
        if not match:
            continue
        if match.group(1).strip() == "features":
            features_index = index
            next_section = len(lines)
            continue
        if features_index is not None and index > features_index:
            next_section = index
            break

    if features_index is None:
        updated = text.rstrip() + "\n\n[features]\ncodex_hooks = true\n"
        path.write_text(updated, encoding="utf-8")
        return True

    setting_re = re.compile(r"^(\s*codex_hooks\s*=\s*)(true|false)(\s*(?:#.*)?)$", re.IGNORECASE)
    for index in range(features_index + 1, next_section):
        match = setting_re.match(lines[index])
        if not match:
            continue
        if match.group(2).lower() == "true":
            return False
        lines[index] = f"{match.group(1)}true{match.group(3)}"
        path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        return True

    lines.insert(features_index + 1, "codex_hooks = true")
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return True


def ensure_codex_hooks(repo_root: pathlib.Path) -> bool:
    path = repo_root / ".codex" / "hooks.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Cannot update {path}: invalid JSON") from exc
    else:
        payload = {}

    hooks_root = payload.setdefault("hooks", {})
    updated = False

    def add_hook(event_name: str, matcher: str | None, command: str, status_message: str, timeout: int) -> None:
        nonlocal updated
        groups = hooks_root.setdefault(event_name, [])
        for group in groups:
            if not isinstance(group, dict):
                continue
            for hook in group.get("hooks", []):
                if isinstance(hook, dict) and hook.get("type") == "command" and hook.get("command") == command:
                    return
        group: dict[str, object] = {
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": timeout,
                    "statusMessage": status_message,
                }
            ]
        }
        if matcher is not None:
            group["matcher"] = matcher
        groups.append(group)
        updated = True

    add_hook(
        "SessionStart",
        "startup|resume",
        f'{installed_script_command("codex_hook")} session-start',
        "Loading proofd guidance...",
        30,
    )
    add_hook(
        "UserPromptSubmit",
        None,
        f'{installed_script_command("codex_hook")} user-prompt-submit',
        "Loading proofd context...",
        30,
    )

    if updated:
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return updated


def write_claude_snippet(repo_root: pathlib.Path) -> pathlib.Path:
    target = repo_root / ".claude" / "agent-proofs-CLAUDE-snippet.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(build_claude_snippet().rstrip() + "\n", encoding="utf-8")
    return target


def write_codex_snippet(repo_root: pathlib.Path) -> pathlib.Path:
    target = repo_root / ".codex" / "agent-proofs-AGENTS-snippet.md"
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
    codex_config_updated = ensure_codex_hooks_feature(repo_root)
    codex_hooks_updated = ensure_codex_hooks(repo_root)

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
    codex_snippet_path = write_codex_snippet(repo_root)

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
    if codex_config_updated:
        print("Updated .codex/config.toml: enabled Codex hooks.")
    else:
        print(".codex/config.toml already enabled Codex hooks.")
    if codex_hooks_updated:
        print("Updated .codex/hooks.json: added agent-proofs Codex hooks.")
    else:
        print(".codex/hooks.json already contains agent-proofs Codex hooks.")
    print(f"Wrote CLAUDE.md integration snippet: {snippet_path}")
    print(f"Wrote AGENTS.md integration snippet: {codex_snippet_path}")
    print("")
    print("Next steps:")
    print("1. Merge the snippet into the repo's CLAUDE.md.")
    print("2. Merge the AGENTS snippet into the repo's AGENTS.md if Codex does not already read CLAUDE.md through a symlink or fallback.")
    print("3. Review generated `.claude/rules/`, then run proofd lint.")
    print("4. Decide whether this repo will track the generated rule snapshots and keep that policy consistent.")
    print("5. Start using `/r`, `/j`, `/b`, `/c`, `/rj`, and `proofd` from this repo root.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
