#!/usr/bin/env python3
"""
Launch Codex as a subprocess for Claude workflow delegation.

This is intentionally a thin wrapper around `codex exec`:
- it builds a workflow-specific prompt via the installed `codex_handoff.py`
- it runs Codex in the current repo/worktree
- it grants Codex the extra writable directories needed for proofd state
  and worktree/common-git-dir operations
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
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


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent


def local_script(name: str) -> str:
    return str((SCRIPT_DIR / name).resolve())


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


def git_value(repo_root: pathlib.Path, args: list[str]) -> str:
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


def proofd_status(repo_root: pathlib.Path) -> dict:
    result = subprocess.run(
        [sys.executable, local_script("proofd.py"), "--repo-root", str(repo_root), "status"],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "proofd status failed")
    return json.loads(result.stdout)


def build_prompt(repo_root: pathlib.Path, workflow: str, workflow_args: list[str]) -> str:
    command = [
        sys.executable,
        local_script("codex_handoff.py"),
        "--repo-root",
        str(repo_root),
        "--no-save",
        workflow,
        *workflow_args,
    ]
    result = subprocess.run(
        command,
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env(),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "codex_handoff failed")
    return result.stdout


def default_sandbox(workflow: str) -> str:
    if workflow == "review":
        return "read-only"
    if workflow in {"janitor", "review-janitor"}:
        return "danger-full-access"
    return "workspace-write"


def default_approval_policy() -> str:
    return "never"


def workflow_requests_release(workflow: str, workflow_args: list[str]) -> bool:
    if workflow != "build":
        return False
    joined = " ".join(workflow_args).lower()
    return "release" in joined


def resolve_codex_executable() -> str:
    direct = shutil.which("codex.cmd") or shutil.which("codex")
    if direct:
        return direct

    candidate_paths: list[pathlib.Path] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidate_paths.extend(
            [
                pathlib.Path(appdata) / "npm" / "codex.cmd",
                pathlib.Path(appdata) / "npm" / "codex",
                pathlib.Path(appdata) / "npm" / "codex.ps1",
            ]
        )
    home = pathlib.Path.home()
    candidate_paths.extend(
        [
            home / "AppData" / "Roaming" / "npm" / "codex.cmd",
            home / "AppData" / "Roaming" / "npm" / "codex",
            home / "AppData" / "Roaming" / "npm" / "codex.ps1",
        ]
    )
    for path in candidate_paths:
        if path.exists():
            return str(path)

    raise RuntimeError(
        "Could not find the Codex CLI executable. Install it or put it on PATH, "
        "or ensure the Windows npm global bin directory is available "
        "(expected e.g. C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd)."
    )


def writable_dirs(repo_root: pathlib.Path, status: dict) -> list[pathlib.Path]:
    kb_root = pathlib.Path(status["kb_root"]).resolve()
    state_root = pathlib.Path(status["state_db"]).resolve().parent
    common_dir_value = git_value(repo_root, ["rev-parse", "--git-common-dir"]) or ".git"
    common_dir = pathlib.Path(common_dir_value)
    if not common_dir.is_absolute():
        common_dir = (repo_root / common_dir).resolve()
    absolute_git_dir = pathlib.Path(git_value(repo_root, ["rev-parse", "--absolute-git-dir"]) or str(repo_root / ".git")).resolve()

    ordered = []
    for path in (kb_root, state_root, common_dir, absolute_git_dir):
        if path not in ordered:
            ordered.append(path)
    return ordered


def save_text(path: pathlib.Path, content: str) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def stamp_path(repo_root: pathlib.Path, prefix: str, suffix: str) -> pathlib.Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return repo_root / "plans" / f"{prefix}-{stamp}.{suffix}"


READ_ONLY_RESULT_WATCH_WORKFLOWS = {"review"}
RESULT_FILE_GRACE_SECONDS = 8.0
POLL_INTERVAL_SECONDS = 1.0


def result_file_ready(path: pathlib.Path) -> bool:
    try:
        return bool(path.exists() and path.read_text(encoding="utf-8", errors="replace").strip())
    except OSError:
        return False


def run_codex_process(
    *,
    command: list[str],
    repo_root: pathlib.Path,
    prompt: str,
    result_path: pathlib.Path,
    workflow: str,
) -> tuple[str, str, int, bool]:
    watch_result = workflow in READ_ONLY_RESULT_WATCH_WORKFLOWS
    with tempfile.TemporaryFile(mode="w+t", encoding="utf-8", errors="replace") as stdout_file, tempfile.TemporaryFile(
        mode="w+t", encoding="utf-8", errors="replace"
    ) as stderr_file:
        process = subprocess.Popen(
            command,
            cwd=str(repo_root),
            stdin=subprocess.PIPE,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=child_env(),
        )
        if process.stdin is None:
            raise RuntimeError("Failed to open stdin for Codex subprocess")
        process.stdin.write(prompt)
        process.stdin.close()

        result_seen_at: float | None = None
        forced_stop = False
        while True:
            returncode = process.poll()
            if watch_result:
                if result_file_ready(result_path):
                    if result_seen_at is None:
                        result_seen_at = time.monotonic()
                    elif returncode is None and time.monotonic() - result_seen_at >= RESULT_FILE_GRACE_SECONDS:
                        print("Result file detected; stopping lingering Codex process for read-only workflow.")
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                        forced_stop = True
                        returncode = process.returncode
                else:
                    result_seen_at = None
            if returncode is not None:
                break
            time.sleep(POLL_INTERVAL_SECONDS)

        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout = stdout_file.read()
        stderr = stderr_file.read()
        return stdout, stderr, process.returncode or 0, forced_stop


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Launch Codex as a subprocess for a Claude workflow")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--sandbox", choices=["read-only", "workspace-write", "danger-full-access"], default=None)
    parser.add_argument("--approval", choices=["untrusted", "on-failure", "on-request", "never"], default=None)
    parser.add_argument("--full-access", action="store_true", help="Run Codex with danger-full-access. Required for push/release workflows.")
    parser.add_argument("--model", default=None)
    parser.add_argument("--ephemeral", action="store_true")
    parser.add_argument("workflow", choices=["review", "janitor", "build", "review-janitor"])
    parser.add_argument("workflow_args", nargs=argparse.REMAINDER)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    repo_root = repo_root_from(pathlib.Path(args.repo_root).resolve())
    status = proofd_status(repo_root)
    release_requested = workflow_requests_release(args.workflow, args.workflow_args)
    sandbox = args.sandbox or ("danger-full-access" if args.full_access or release_requested else default_sandbox(args.workflow))
    approval = args.approval or default_approval_policy()
    codex_executable = resolve_codex_executable()

    prompt = build_prompt(repo_root, args.workflow, args.workflow_args)
    prompt_path = save_text(stamp_path(repo_root, f"codex-prompt-{args.workflow}", "md"), prompt)
    result_path = stamp_path(repo_root, f"codex-result-{args.workflow}", "md")

    command = [
        codex_executable,
        "--ask-for-approval",
        approval,
        "exec",
        "--cd",
        str(repo_root),
        "--sandbox",
        sandbox,
        "--output-last-message",
        str(result_path),
        "--color",
        "never",
    ]
    if args.model:
        command.extend(["--model", args.model])
    if args.ephemeral:
        command.append("--ephemeral")
    for path in writable_dirs(repo_root, status):
        command.extend(["--add-dir", str(path)])
    command.append("-")

    print(f"Prompt file: {prompt_path}")
    print(f"Result file: {result_path}")
    print(f"Sandbox: {sandbox}")
    print(f"Approval policy: {approval}")
    print(f"Repo root: {repo_root}")
    print(f"Codex executable: {codex_executable}")
    if args.workflow in {"janitor", "review-janitor"} and not args.sandbox and not args.full_access:
        print("Access mode: auto-promoted to danger-full-access because janitor workflows need local proofd and git plumbing")
    elif release_requested and not args.sandbox and not args.full_access:
        print("Access mode: auto-promoted to danger-full-access because the requested build flow includes release steps")
    print("")

    try:
        stdout_text, stderr_text, actual_returncode, forced_stop = run_codex_process(
            command=command,
            repo_root=repo_root,
            prompt=prompt,
            result_path=result_path,
            workflow=args.workflow,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"Failed to launch Codex CLI at {codex_executable}: {exc}") from exc
    if stdout_text:
        emit_text(stdout_text)
        if not stdout_text.endswith("\n"):
            emit_text("\n")
    if stderr_text:
        emit_text(stderr_text, stream=sys.stderr)
        if not stderr_text.endswith("\n"):
            emit_text("\n", stream=sys.stderr)
    effective_returncode = 0 if forced_stop and result_file_ready(result_path) else actual_returncode
    print("")
    if forced_stop and effective_returncode == 0:
        print(f"Codex exit code: {effective_returncode} (result captured; original process exit code {actual_returncode})")
    else:
        print(f"Codex exit code: {effective_returncode}")
    print(f"Prompt file: {prompt_path}")
    print(f"Result file: {result_path}")
    return effective_returncode


if __name__ == "__main__":
    raise SystemExit(main())
