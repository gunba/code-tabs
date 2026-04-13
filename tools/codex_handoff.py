#!/usr/bin/env python3
"""
Generate Codex handoff briefs for Claude workflow commands.

The briefs are designed for the installed `codex_delegate.py`, which
launches `codex exec` as a subprocess from Claude. They can also be
saved and used manually when needed.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import subprocess
import sys
from datetime import datetime

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def child_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent


def script_command(name: str) -> str:
    return f'python "{(SCRIPT_DIR / name).resolve().as_posix()}"'


PROOFD_CMD = script_command("proofd.py")
DELEGATE_CMD = script_command("codex_delegate.py")
PROOFD_CONTEXT_MAX_FILES = 24
PATH_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+")
BARE_FILE_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_.-])")
SKIP_CONTEXT_SUFFIXES = {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".dll", ".exe"}


def emit_text(content: str, stream: object = sys.stdout) -> None:
    try:
        stream.write(content)
    except UnicodeEncodeError:
        buffer = getattr(stream, "buffer", None)
        if buffer is not None:
            buffer.write(content.encode("utf-8", errors="replace"))
        else:
            stream.write(content.encode("ascii", errors="replace").decode("ascii"))
    try:
        stream.flush()
    except Exception:
        pass


def run_git(repo_root: pathlib.Path, args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
        check=False,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


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
    if result.returncode == 0 and result.stdout.strip():
        return pathlib.Path(result.stdout.strip())
    return path.resolve()


def current_branch(repo_root: pathlib.Path) -> str:
    return run_git(repo_root, ["branch", "--show-current"]) or "detached"


def changed_files(repo_root: pathlib.Path, scope: str) -> list[str]:
    files: list[str] = []
    if scope in {"uncommitted", "both"}:
        output = run_git(repo_root, ["diff", "HEAD", "--name-only"])
        files.extend(line.strip() for line in output.splitlines() if line.strip())
    if scope in {"unpushed", "both"}:
        output = run_git(repo_root, ["diff", "origin/HEAD..HEAD", "--name-only"])
        files.extend(line.strip() for line in output.splitlines() if line.strip())
    deduped: list[str] = []
    seen = set()
    for file_name in files:
        if file_name not in seen:
            seen.add(file_name)
            deduped.append(file_name)
    return deduped


def rule_context_paths(repo_root: pathlib.Path, paths: list[str]) -> list[str]:
    filtered: list[str] = []
    for file_name in paths:
        normalized = file_name.replace("\\", "/").strip()
        if not normalized:
            continue
        if normalized.startswith(".proofs/") or normalized.startswith(".claude/rules/"):
            continue
        if "/__pycache__/" in f"/{normalized}" or pathlib.Path(normalized).suffix.lower() in SKIP_CONTEXT_SUFFIXES:
            continue
        if not (repo_root / normalized).exists():
            continue
        filtered.append(normalized)
    return filtered


def limited_paths(paths: list[str], limit: int = PROOFD_CONTEXT_MAX_FILES) -> list[str]:
    deduped: list[str] = []
    seen = set()
    for path in paths:
        if path not in seen:
            seen.add(path)
            deduped.append(path)
    return deduped[:limit]


def proofd_context(repo_root: pathlib.Path, paths: list[str]) -> str:
    selected = limited_paths(rule_context_paths(repo_root, paths))
    if not selected:
        return ""
    result = subprocess.run(
        [sys.executable, str((SCRIPT_DIR / "proofd.py").resolve()), "--repo-root", str(repo_root), "context", *selected],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
        check=False,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def proofd_select_matching(repo_root: pathlib.Path, paths: list[str]) -> str:
    selected = rule_context_paths(repo_root, paths)
    if not selected:
        return ""
    result = subprocess.run(
        [sys.executable, str((SCRIPT_DIR / "proofd.py").resolve()), "--repo-root", str(repo_root), "select-matching", *selected],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
        check=False,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def plan_context_paths(repo_root: pathlib.Path, plan_text: str) -> list[str]:
    candidates = ["CLAUDE.md"]
    for pattern in (PATH_TOKEN_RE, BARE_FILE_TOKEN_RE):
        for match in pattern.findall(plan_text):
            token = match.strip("`'\"()[]{}<>,.;:")
            normalized = token.replace("\\", "/").lstrip("./")
            if normalized:
                candidates.append(normalized)
    return rule_context_paths(repo_root, candidates)


def write_output(output_path: pathlib.Path | None, content: str) -> pathlib.Path | None:
    if output_path is None:
        return None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")
    return output_path


def default_output_path(repo_root: pathlib.Path, workflow: str) -> pathlib.Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return repo_root / "plans" / f"codex-{workflow}-{stamp}.md"


def workflow_label(workflow: str) -> str:
    mapping = {
        "review": "/r",
        "janitor": "/j",
        "build": "/b",
        "review-janitor": "/rj",
    }
    return mapping.get(workflow, workflow)


def header(repo_root: pathlib.Path, workflow: str, mode: str) -> list[str]:
    return [
        f"# Codex Handoff: {workflow.title()}",
        "",
        f"- Repo: `{repo_root}`",
        f"- Branch: `{current_branch(repo_root)}`",
        f"- Requested by: Claude `{workflow_label(workflow)}` workflow",
        f"- Mode: `{mode}`",
        f"- Execution: intended for `{DELEGATE_CMD} ...` in the current worktree",
        "- Workspace: the current worktree may contain uncommitted changes; treat that state as authoritative input",
        "",
    ]


def rule_context_lines(repo_root: pathlib.Path, paths: list[str], read_only: bool = False) -> list[str]:
    selected = limited_paths(rule_context_paths(repo_root, paths))
    preloaded = proofd_context(repo_root, selected)
    lines = [
        "## Rule Context",
        "Codex does not auto-load `.claude/rules` by touched file path the way Claude does.",
    ]
    if selected:
        lines.extend(
            [
                "",
                "Claude preloaded proofd context for these files:",
                "```text",
                "\n".join(selected),
                "```",
            ]
        )
        omitted = len(rule_context_paths(repo_root, paths)) - len(selected)
        if omitted > 0:
            lines.extend(["", f"{omitted} additional file(s) were omitted from the preload to keep the prompt bounded."])
    if preloaded:
        if read_only:
            lines.extend(
                [
                    "",
                    "Use the preloaded proofd context below as your primary rules input. In this read-only sandbox, do not rely on launching `proofd` CLI commands from inside Codex.",
                    "",
                    preloaded,
                ]
            )
        else:
            lines.extend(
                [
                    "",
                    "Start with the preloaded proofd context below. If you need more, you may use the CLI or `proofd_context` MCP tool.",
                    "",
                    preloaded,
                ]
            )
    elif read_only:
        lines.extend(
            [
                "",
                "No preloaded proofd context was available. In this read-only sandbox, prefer `CLAUDE.md` and relevant `.claude/rules/*.md` files over ad hoc CLI lookups.",
            ]
        )
    else:
        lines.extend(
            [
                "",
                "If you need more rule context, request it explicitly with either:",
                f"- `{PROOFD_CMD} context <paths...>`",
                "- the `proofd_context` MCP tool if `proofd` is already configured in this Codex environment",
            ]
        )
    lines.append("")
    return lines


def proof_selection_lines(repo_root: pathlib.Path, paths: list[str]) -> list[str]:
    preloaded = proofd_select_matching(repo_root, paths)
    lines = ["## Proof Selection"]
    if preloaded:
        lines.extend(
            [
                "Claude preloaded `proofd select-matching` for the current janitor scope:",
                "```text",
                preloaded,
                "```",
            ]
        )
    else:
        lines.extend(
            [
                f"No preloaded `select-matching` output was available. Run `{PROOFD_CMD} select-matching <files...>` before creating or updating proofs.",
            ]
        )
    lines.append("")
    return lines


def review_handoff(repo_root: pathlib.Path, args: argparse.Namespace) -> str:
    diff_stat = run_git(repo_root, ["diff", "HEAD", "--stat"]) or "(no diff stat)"
    status = run_git(repo_root, ["status", "--short"]) or "(clean working tree)"
    files = changed_files(repo_root, "both")
    context_files = rule_context_paths(repo_root, files)
    lines = header(repo_root, "review", args.mode)
    lines.extend(
        [
            "## Objective",
            "Run the review workflow in Codex against the current workspace.",
            "",
            f"Intent: {args.intent}",
            f"Approach: {args.approach}",
        ]
    )
    if args.limitations:
        lines.extend(["", f"Limitations: {args.limitations}"])
    if args.alternatives:
        lines.extend(["", f"Alternatives: {args.alternatives}"])
    lines.extend(
        [
            "",
            *rule_context_lines(repo_root, context_files, read_only=True),
            "## Instructions",
            "1. Read `CLAUDE.md` and start with the preloaded proofd context for the changed files that still exist in the worktree.",
            "2. Inspect the diff and relevant files directly.",
            "3. Do not edit files, stage changes, or apply fixes. This is a read-only review pass.",
            "4. Run relevant validation commands only when they can complete without mutating the workspace. If a useful command needs write access, report that gap instead of changing the tree.",
            "5. Report findings by severity with concrete fixes.",
            "6. Include simplification suggestions and testing gaps.",
        ]
    )
    if args.mode == "adversarial":
        lines.append("7. Treat this as an independent second opinion. Do not anchor on Claude's likely conclusions.")
    else:
        lines.append("7. Produce a normal Codex review pass.")
    lines.extend(
        [
            "8. End with `## Cited` and list any tags you actually relied on.",
            "9. Do not log the run yourself. Claude will log the review after the subprocess returns.",
            "",
            "## Workspace State",
            "```text",
            status,
            "```",
            "",
            "## Changed Files",
            "```text",
            diff_stat,
            "```",
            "",
        ]
    )
    return "\n".join(lines)


def janitor_handoff(repo_root: pathlib.Path, args: argparse.Namespace) -> str:
    files = changed_files(repo_root, args.scope)
    context_files = rule_context_paths(repo_root, files)
    lines = header(repo_root, "janitor", "codex")
    lines.extend(
        [
            "## Objective",
            "Run the janitor workflow in Codex: prove matching rules, create missing tags through proofd, sync generated rules, and lint the result.",
            "",
            f"Scope: `{args.scope}`",
            "",
            "## Changed Files",
            "```text",
            "\n".join(files) if files else "(no changed files found for this scope)",
            "```",
            "",
            *rule_context_lines(repo_root, context_files),
            *proof_selection_lines(repo_root, files),
            "## Instructions",
            "1. Determine the actual changed file list for the requested scope.",
            "2. Start with the preloaded proofd context and the preloaded `select-matching` output above.",
            f"3. If you need a fresh selection, run `{PROOFD_CMD} select-matching <files...>`.",
            "4. Prove each selected entry against source code.",
            f"5. Record outcomes with `{PROOFD_CMD} record-verification ...`.",
            "6. If documentation is missing, create rules or entries through `proofd` and only then add the source-code tag anchor.",
            "7. If an existing source tag already covers the implementation site, reuse and cite it instead of creating a duplicate tag.",
            "8. Limit writes to proof-maintenance work: proofd state, canonical or overlay rule data, generated `.claude/rules`, and source tag comments. Do not make unrelated product-code changes.",
            "9. If `proofd` MCP is already configured in this Codex environment you may use it; otherwise use the CLI.",
            f"10. Run `{PROOFD_CMD} sync` and `{PROOFD_CMD} lint`.",
            "11. `sync` regenerates local `.claude/rules/*.md` files for Claude context injection. Those files are generated output; do not edit them manually.",
            "12. If this repo tracks `.claude/rules`, include the refreshed snapshot in the branch. The canonical proof update still lives in proofd KB/state plus any source tag comments you changed.",
            "13. Do not log, commit, merge, or exit the worktree from inside this subprocess. Claude will handle finalization after the janitor pass returns.",
            "14. End with a report plus `## Cited`. If janitor is blocked, say so explicitly.",
            "",
        ]
    )
    return "\n".join(lines)


def build_handoff(repo_root: pathlib.Path, args: argparse.Namespace) -> str:
    status = run_git(repo_root, ["status", "--short"]) or "(clean working tree)"
    lines = header(repo_root, "build", "codex")
    lines.extend(
        [
            "## Objective",
            "Run the build workflow in Codex.",
            "",
            f"Requested steps: `{args.steps}`",
            "",
            "## Workspace State",
            "```text",
            status,
            "```",
            "",
            *rule_context_lines(repo_root, []),
            "## Instructions",
            "1. Read `CLAUDE.md` for build commands and `DOCS/RELEASE.md` for release/version workflow.",
            "2. Request proofd context for any files you inspect or modify during the build flow. If `proofd` MCP is already configured in this Codex environment you may use it; otherwise use the CLI.",
            "3. Execute only the requested build pipeline steps.",
            f"4. If commit or release is included and you are not using repo build scripts that already refresh rules, run `{PROOFD_CMD} sync` first.",
            "5. Treat `.claude/rules/*.md` as generated but normal repo files: never edit them manually, and include the refreshed snapshot when it changes.",
            "6. If commit is included, match recent commit style.",
            "7. If release is included, validate before bump, push, or release creation.",
            "8. This subprocess is non-interactive. Approval prompts are disabled; release-capable flows may be launched with full access by the wrapper so push and release steps can complete.",
            "9. Record build duration and summarize what was done.",
            "10. Do not log the run yourself. Claude will handle run logging after the subprocess returns.",
            "11. End with a concise report suitable for the user.",
            "",
        ]
    )
    return "\n".join(lines)


def review_janitor_handoff(repo_root: pathlib.Path, args: argparse.Namespace) -> str:
    diff_stat = run_git(repo_root, ["diff", "HEAD", "--stat"]) or "(no diff stat)"
    files = changed_files(repo_root, args.scope)
    context_files = rule_context_paths(repo_root, files)
    lines = header(repo_root, "review-janitor", args.mode)
    lines.extend(
        [
            "## Objective",
            "Run review and janitor as a combined Codex workflow.",
            "",
            f"Review mode: `{args.mode}`",
            f"Janitor scope: `{args.scope}`",
            "",
            "## Changed Files",
            "```text",
            diff_stat,
            "```",
            "",
            "## Prove Scope Seed",
            "```text",
            "\n".join(files) if files else "(no changed files found for this scope)",
            "```",
            "",
            *rule_context_lines(repo_root, context_files),
            *proof_selection_lines(repo_root, files),
            "## Instructions",
            "1. Run the review pass first and keep it read-only.",
            "2. Then run the janitor or proof pass against the requested scope.",
            "3. Start the janitor phase with the preloaded proofd context and the preloaded `select-matching` output above.",
            f"4. If you need a fresh proof selection, run `{PROOFD_CMD} select-matching <files...>`.",
            "5. During the janitor phase, limit writes to proof-maintenance work: proofd state, canonical or overlay rule data, generated `.claude/rules`, and source tag comments.",
            "6. If an existing source tag already covers the implementation site, reuse and cite it instead of creating a duplicate tag.",
            "7. If `proofd` MCP is already configured in this Codex environment you may use it; otherwise use the CLI.",
            "8. When janitor runs `sync`, remember that `.claude/rules/*.md` is generated local output. Do not edit it manually, and if this repo tracks it, include the refreshed snapshot in the branch.",
            "9. Keep review findings and janitor or proof outcomes separate in the final report.",
            "10. Do not log, commit, merge, or exit the worktree from inside this subprocess. Claude will handle that after the combined pass returns.",
            "11. End each section with any cited tags used in that phase, and say explicitly if janitor was blocked.",
            "",
        ]
    )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate Codex handoff briefs for Claude workflows")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output", default=None, help="Optional output markdown path")
    parser.add_argument("--no-save", action="store_true", help="Print only the handoff content without writing a file")

    subparsers = parser.add_subparsers(dest="workflow", required=True)

    review = subparsers.add_parser("review")
    review.add_argument("--intent", required=True)
    review.add_argument("--approach", required=True)
    review.add_argument("--limitations", default=None)
    review.add_argument("--alternatives", default=None)
    review.add_argument("--mode", choices=["codex", "adversarial"], default="codex")

    janitor = subparsers.add_parser("janitor")
    janitor.add_argument("--scope", choices=["uncommitted", "unpushed", "both"], default="uncommitted")

    review_janitor = subparsers.add_parser("review-janitor")
    review_janitor.add_argument("--scope", choices=["uncommitted", "unpushed", "both"], default="uncommitted")
    review_janitor.add_argument("--mode", choices=["codex", "adversarial"], default="codex")

    build = subparsers.add_parser("build")
    build.add_argument("--steps", choices=["build-only", "commit-build", "build-release", "commit-build-release"], required=True)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    repo_root = repo_root_from(pathlib.Path(args.repo_root).resolve())
    output_path = None if args.no_save else (pathlib.Path(args.output).resolve() if args.output else default_output_path(repo_root, args.workflow))

    if args.workflow == "review":
        content = review_handoff(repo_root, args)
    elif args.workflow == "janitor":
        content = janitor_handoff(repo_root, args)
    elif args.workflow == "review-janitor":
        content = review_janitor_handoff(repo_root, args)
    elif args.workflow == "build":
        content = build_handoff(repo_root, args)
    else:
        raise RuntimeError(f"Unknown workflow: {args.workflow}")

    saved = write_output(output_path, content)
    if saved:
        print(f"Saved: {saved}")
        print("")
    emit_text(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
