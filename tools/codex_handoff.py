#!/usr/bin/env python3
"""
Generate Codex handoff briefs for Claude workflow commands.

The briefs are designed for `tools/codex_delegate.py`, which launches
`codex exec` as a subprocess from Claude. They can also be saved and
used manually when needed.
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
from datetime import datetime


def run_git(repo_root: pathlib.Path, args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
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
        if not (repo_root / normalized).exists():
            continue
        filtered.append(normalized)
    return filtered


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
        "plan": "plan-critic",
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
        "- Execution: intended for `python tools/codex_delegate.py ...` in the current worktree",
        "- Workspace: the current worktree may contain uncommitted changes; treat that state as authoritative input",
        "",
    ]


def rule_context_lines(paths: list[str]) -> list[str]:
    lines = [
        "## Rule Context",
        "Codex does not auto-load `.claude/rules` by touched file path the way Claude does.",
        "Before acting on a file, request rule context explicitly with either:",
        "- `python tools/proofd.py context <paths...>`",
        "- the `proofd_context` MCP tool if `proofd` is already configured in this Codex environment",
    ]
    if paths:
        lines.extend(
            [
                "",
                "Suggested initial files:",
                "```text",
                "\n".join(paths),
                "```",
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
            *rule_context_lines(context_files),
            "## Instructions",
            "1. Read `CLAUDE.md` and then request proofd rule context for the changed files that still exist in the worktree.",
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
            "9. Log the run with `python tools/proofd.py log-run --cmd r --summary \"...\" --cited-up \"TAG,TAG\"`.",
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
            *rule_context_lines(context_files),
            "## Instructions",
            "1. Determine the actual changed file list for the requested scope.",
            "2. Request proofd rule context for those files before proving them.",
            "3. Run `python tools/proofd.py select-matching <files...>`.",
            "4. Prove each selected entry against source code.",
            "5. Record outcomes with `python tools/proofd.py record-verification ...`.",
            "6. If documentation is missing, create rules or entries through `proofd` and only then add the source-code tag anchor.",
            "7. Limit writes to proof-maintenance work: proofd state, canonical or overlay rule data, generated `.claude/rules`, and source tag comments. Do not make unrelated product-code changes.",
            "8. If `proofd` MCP is already configured in this Codex environment you may use it; otherwise use the CLI.",
            "9. Run `python tools/proofd.py sync` and `python tools/proofd.py lint`.",
            "10. End with a report plus `## Cited`.",
            "11. Log the run with `python tools/proofd.py log-run --cmd j --summary \"...\" --cited-up \"TAG,TAG\"`.",
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
            *rule_context_lines([]),
            "## Instructions",
            "1. Read `CLAUDE.md` for build commands and `DOCS/RELEASE.md` for release/version workflow.",
            "2. Request proofd context for any files you inspect or modify during the build flow. If `proofd` MCP is already configured in this Codex environment you may use it; otherwise use the CLI.",
            "3. Execute only the requested build pipeline steps.",
            "4. If commit is included, match recent commit style.",
            "5. If release is included, validate before bump, push, or release creation.",
            "6. This subprocess is non-interactive. Approval prompts are disabled; release-capable flows may be launched with full access by the wrapper so push and release steps can complete.",
            "7. Record build duration and summarize what was done.",
            "8. End with a concise report suitable for the user.",
            "9. Log the run with `python tools/proofd.py log-run --cmd b --summary \"...\" --build-time <seconds>`.",
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
            *rule_context_lines(context_files),
            "## Instructions",
            "1. Run the review pass first and keep it read-only.",
            "2. Then run the janitor or proof pass against the requested scope.",
            "3. Request proofd rule context before acting on the changed files.",
            "4. During the janitor phase, limit writes to proof-maintenance work: proofd state, canonical or overlay rule data, generated `.claude/rules`, and source tag comments.",
            "5. If `proofd` MCP is already configured in this Codex environment you may use it; otherwise use the CLI.",
            "6. Keep review findings and janitor or proof outcomes separate in the final report.",
            "7. End each section with any cited tags used in that phase.",
            "8. Log the combined run with `python tools/proofd.py log-run --cmd rj --summary \"...\" --cited-up \"TAG,TAG\"`.",
            "",
        ]
    )
    return "\n".join(lines)


def plan_handoff(repo_root: pathlib.Path, args: argparse.Namespace) -> str:
    plan_path = pathlib.Path(args.plan_file).resolve()
    plan_text = plan_path.read_text(encoding="utf-8")
    lines = header(repo_root, "plan", args.mode)
    lines.extend(
        [
            "## Objective",
            "Critique the attached implementation plan before it is presented to the user.",
            "",
            *rule_context_lines([]),
            "## Instructions",
            "1. Read `CLAUDE.md` and inspect the codebase as needed.",
            "2. Request proofd context for any files or areas you inspect. If `proofd` MCP is already configured in this Codex environment you may use it; otherwise use the CLI.",
            "3. Do not edit files or implement the plan. This is a critique-only pass.",
            "4. Critique the plan for abstraction, reuse, and risk.",
            "5. Point out missing steps, risky assumptions, and existing code or tooling the plan should reuse.",
        ]
    )
    if args.mode == "adversarial":
        lines.append("6. Treat this as an adversarial critique. Challenge weak assumptions directly.")
    else:
        lines.append("6. Produce a normal plan-critic pass.")
    lines.extend(
        [
            "",
            f"## Draft Plan Source\n`{plan_path}`",
            "",
            "## Draft Plan",
            "```markdown",
            plan_text.rstrip(),
            "```",
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

    plan = subparsers.add_parser("plan")
    plan.add_argument("--plan-file", required=True)
    plan.add_argument("--mode", choices=["codex", "adversarial"], default="codex")

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
    elif args.workflow == "plan":
        content = plan_handoff(repo_root, args)
    else:
        raise RuntimeError(f"Unknown workflow: {args.workflow}")

    saved = write_output(output_path, content)
    if saved:
        print(f"Saved: {saved}")
        print("")
    print(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
