#!/usr/bin/env python3
"""
proofd: externalized proofs/rules tooling for Claude Tabs.

The code repo keeps only generated `.claude/rules/*.md`.
Canonical rule data lives in a companion knowledge base root.
Operational state lives in SQLite.

This script intentionally uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import copy
import fnmatch
import hashlib
import itertools
import json
import os
import pathlib
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse


SCHEMA_VERSION = 1
ENTRY_RE = re.compile(r"^- \[([A-Z]{2}-\d{2,4})\]\s+(.*)$")
SOURCE_TAG_RE = re.compile(r"\[([A-Z]{2}-\d{2,4})\]")
DEFAULT_SOURCE_DIRS = ["src", "src-tauri/src"]
DEFAULT_BATCH_SIZE = 20

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def normalize_path(value: str) -> str:
    return value.replace("\\", "/").strip()


def normalize_anchor_path(value: str) -> str:
    normalized = normalize_path(value)
    normalized = re.sub(r":\d+$", "", normalized)
    if re.match(r"^[A-Za-z]:(src/|src-tauri/|DOCS/|\.claude/)", normalized):
        normalized = normalized[2:]
    return normalized


def slugify(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-").lower()
    return value or "rule"


def ensure_dir(path: pathlib.Path) -> pathlib.Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def stable_json(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


def is_windows() -> bool:
    return os.name == "nt"


def default_state_root() -> pathlib.Path:
    if is_windows():
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return pathlib.Path(base) / "proofd"
    return pathlib.Path(os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state")) / "proofd"


def default_kb_root() -> pathlib.Path:
    return pathlib.Path.home() / ".proofd" / "kb"


def run_git(args: list[str], cwd: pathlib.Path) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def git_output(args: list[str], cwd: pathlib.Path) -> str | None:
    try:
        return run_git(args, cwd)
    except RuntimeError:
        return None


def repo_root_from(path: pathlib.Path) -> pathlib.Path:
    git_root = git_output(["rev-parse", "--show-toplevel"], path)
    return pathlib.Path(git_root) if git_root else path.resolve()


def current_branch(repo_root: pathlib.Path) -> str:
    value = git_output(["branch", "--show-current"], repo_root)
    return value or "detached"


def git_common_dir(repo_root: pathlib.Path) -> pathlib.Path:
    value = git_output(["rev-parse", "--git-common-dir"], repo_root) or ".git"
    path = pathlib.Path(value)
    if not path.is_absolute():
        path = (repo_root / path).resolve()
    return path


def git_main_worktree_root(repo_root: pathlib.Path) -> pathlib.Path | None:
    output = git_output(["worktree", "list", "--porcelain"], repo_root) or ""
    for line in output.splitlines():
        if line.startswith("worktree "):
            return pathlib.Path(line[len("worktree ") :].strip()).resolve()
    return None


def default_branch(repo_root: pathlib.Path) -> str:
    ref = git_output(["symbolic-ref", "refs/remotes/origin/HEAD"], repo_root)
    if ref and "/" in ref:
        return ref.rsplit("/", 1)[-1]
    for candidate in ("main", "master"):
        branches = git_output(["branch", "--list", candidate], repo_root)
        if branches:
            return candidate
    return "main"


def remote_basename(value: str) -> str:
    candidate = value.rstrip("/").rsplit("/", 1)[-1]
    return candidate[:-4] if candidate.endswith(".git") else candidate


def normalize_repo_key(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    if "://" in raw:
        parsed = urlparse(raw)
        if parsed.scheme == "file":
            normalized = normalize_path(parsed.path).rstrip("/")
            return normalized or None
        host = (parsed.hostname or "").lower()
        path = parsed.path.lstrip("/").rstrip("/")
        if not host or not path:
            return None
        if path.endswith(".git"):
            path = path[:-4]
        return f"{host}/{path}".lower()
    scp_match = re.match(r"^(?:(?P<user>[^@]+)@)?(?P<host>[^:/\\]+):(?P<path>.+)$", raw)
    if scp_match and "/" in scp_match.group("path"):
        host = scp_match.group("host").lower()
        path = scp_match.group("path").lstrip("/").rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        return f"{host}/{path}".lower()
    normalized = normalize_path(raw).rstrip("/")
    return normalized or None


def configured_repo_key(repo_root: pathlib.Path, explicit_repo_key: str | None = None) -> tuple[str | None, str, str | None]:
    if explicit_repo_key:
        repo_key = normalize_repo_key(explicit_repo_key)
        if repo_key:
            return repo_key, "cli", None

    env_key = normalize_repo_key(os.environ.get("PROOFD_REPO_KEY"))
    if env_key:
        return env_key, "env", None

    for config_name in ("proofd.repo-key", "proofd.repoKey"):
        config_value = git_output(["config", "--get", config_name], repo_root)
        repo_key = normalize_repo_key(config_value)
        if repo_key:
            return repo_key, "git-config", None

    origin_remote = git_output(["config", "--get", "remote.origin.url"], repo_root) or None
    repo_key = normalize_repo_key(origin_remote)
    if repo_key:
        return repo_key, "origin", origin_remote
    return None, "path", origin_remote


def repo_identity(repo_root: pathlib.Path, explicit_repo_key: str | None = None) -> dict[str, Any]:
    repo_key, identity_source, origin_remote = configured_repo_key(repo_root, explicit_repo_key=explicit_repo_key)
    base = slugify(remote_basename(repo_key or origin_remote or repo_root.name))
    digest_source = repo_key or str(git_common_dir(repo_root))
    digest = hashlib.sha1(digest_source.encode("utf-8")).hexdigest()[:8]
    return {
        "repo_id": f"{base}-{digest}",
        "display_name": base.replace("-", " ").title(),
        "slug": base,
        "repo_key": repo_key,
        "identity_source": identity_source,
        "origin_remote": origin_remote,
    }


def legacy_repo_identifiers(repo_root: pathlib.Path, slug: str) -> list[str]:
    candidates: set[str] = {str(git_common_dir(repo_root)), str(repo_root.resolve())}
    main_root = git_main_worktree_root(repo_root)
    if main_root is not None:
        candidates.add(str(main_root))
    return sorted(f"{slug}-{hashlib.sha1(candidate.encode('utf-8')).hexdigest()[:8]}" for candidate in candidates)


def split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [normalize_path(item) for item in value.split(",") if item.strip()]


def split_anchor_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [normalize_anchor_path(item) for item in value.split(",") if item.strip()]


def file_matches(path: str, patterns: list[str]) -> bool:
    if not patterns:
        return True
    normalized = normalize_path(path)
    for pattern in patterns:
        candidate = normalize_path(pattern)
        if fnmatch.fnmatch(normalized, candidate):
            return True
        if "**" in candidate:
            prefix = candidate.split("**", 1)[0].rstrip("/")
            if normalized == prefix or normalized.startswith(prefix + "/"):
                return True
    return False


def parse_tag_number(tag_id: str) -> tuple[str, int]:
    prefix, number = tag_id.split("-", 1)
    return prefix, int(number)


def parse_datetime_any(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def sorted_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(entries, key=lambda entry: parse_tag_number(entry["tag_id"]))


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    if not content.startswith("---"):
        return {}, content
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, content
    end_index = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end_index = index
            break
    if end_index is None:
        return {}, content

    frontmatter_lines = lines[1:end_index]
    body = "\n".join(lines[end_index + 1 :]).lstrip("\n")
    data: dict[str, Any] = {}
    list_accumulator: list[str] | None = None
    for raw_line in frontmatter_lines:
        stripped = raw_line.strip()
        if not stripped:
            continue
        if stripped.endswith(":"):
            key = stripped[:-1]
            list_accumulator = []
            data[key] = list_accumulator
            continue
        if stripped.startswith("- ") and list_accumulator is not None:
            list_accumulator.append(stripped[2:].strip().strip('"').strip("'"))
            continue
        if ":" in stripped:
            lhs, rhs = stripped.split(":", 1)
            data[lhs.strip()] = rhs.strip().strip('"').strip("'")
            list_accumulator = None
    return data, body


def render_frontmatter(frontmatter: dict[str, Any]) -> str:
    if not frontmatter:
        return ""
    lines = ["---"]
    for key, value in frontmatter.items():
        if isinstance(value, list):
            lines.append(f"{key}:")
            for item in value:
                lines.append(f'  - "{item}"')
        else:
            lines.append(f'{key}: "{value}"')
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def detect_title(body_lines: list[str], fallback: str) -> tuple[str, int]:
    for index, line in enumerate(body_lines):
        if line.startswith("# "):
            return line[2:].strip(), index
    return fallback, -1


def parse_codes_comment(body: str) -> dict[str, str]:
    match = re.search(r"<!--\s*Codes:\s*(.+?)\s*-->", body)
    if not match:
        return {}
    mapping: dict[str, str] = {}
    for part in match.group(1).split(","):
        if "=" not in part:
            continue
        code, label = part.split("=", 1)
        mapping[code.strip().upper()] = label.strip()
    return mapping


def parse_rule_markdown(path: pathlib.Path) -> dict[str, Any]:
    content = path.read_text(encoding="utf-8")
    frontmatter, body = parse_frontmatter(content)
    lines = body.splitlines()
    title, title_index = detect_title(lines, path.stem.replace("-", " ").title())
    codes = parse_codes_comment(body)

    summary_lines: list[str] = []
    entries: list[dict[str, Any]] = []
    current_entry: dict[str, Any] | None = None
    in_fenced_detail = False

    for index, line in enumerate(lines):
        if index <= title_index:
            continue
        stripped = line.strip()
        if current_entry and stripped.startswith("```"):
            current_entry["details"].append(stripped)
            in_fenced_detail = not in_fenced_detail
            continue
        if current_entry and in_fenced_detail:
            current_entry["details"].append(line.rstrip())
            continue
        entry_match = ENTRY_RE.match(line)
        if entry_match:
            tag_id = entry_match.group(1)
            statement = entry_match.group(2).strip()
            prefix, _ = parse_tag_number(tag_id)
            current_entry = {
                "tag_id": tag_id,
                "statement": statement,
                "anchors": [],
                "details": [],
                "notes": [],
                "prefix": prefix,
            }
            entries.append(current_entry)
            continue
        if current_entry and line.startswith("  - "):
            detail = line[4:].strip()
            current_entry["details"].append(detail)
            if detail.lower().startswith("files:"):
                files = split_anchor_csv(detail.split(":", 1)[1].strip())
                current_entry["anchors"] = [{"path": file_path} for file_path in files]
            continue
        if current_entry and line.startswith("  "):
            continuation = line.strip()
            if current_entry["details"]:
                current_entry["details"][-1] += " " + continuation
            else:
                current_entry["statement"] += " " + continuation
            continue
        if not entries and line.strip() and not line.strip().startswith("<!--"):
            summary_lines.append(line.rstrip())

    known_prefixes = sorted({entry["prefix"] for entry in entries})
    default_prefix = known_prefixes[0] if known_prefixes else (sorted(codes.keys())[0] if codes else None)
    return {
        "schema_version": SCHEMA_VERSION,
        "rule_id": path.stem,
        "title": title,
        "summary": "\n".join(summary_lines).strip(),
        "load_policy": "auto",
        "scope": {"paths": frontmatter.get("paths", [])},
        "default_prefix": default_prefix,
        "known_prefixes": known_prefixes,
        "entries": entries,
        "codes_comment": codes,
        "legacy": {"source_markdown": normalize_path(str(path))},
    }


def entry_index(rule: dict[str, Any], tag_id: str) -> dict[str, Any] | None:
    for entry in rule["entries"]:
        if entry["tag_id"] == tag_id:
            return entry
    return None


class ProofStore:
    def __init__(
        self,
        repo_root: pathlib.Path,
        state_root: pathlib.Path | None = None,
        kb_root: pathlib.Path | None = None,
        repo_key: str | None = None,
    ) -> None:
        self.repo_root = repo_root_from(repo_root)
        self.state_root = ensure_dir((state_root or default_state_root()).resolve())
        self.kb_root = ensure_dir((kb_root or default_kb_root()).resolve())
        self.identity = repo_identity(self.repo_root, explicit_repo_key=repo_key)
        self.db_path = self.state_root / "state.db"
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self._init_db()
        self.profile = self._ensure_repo_profile()

    def close(self) -> None:
        self.conn.close()

    def _init_db(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS repos (
                repo_id TEXT PRIMARY KEY,
                root_path TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                output_dir TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS prefix_registry (
                repo_id TEXT NOT NULL,
                prefix TEXT NOT NULL,
                rule_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (repo_id, prefix)
            );

            CREATE TABLE IF NOT EXISTS tag_counters (
                repo_id TEXT NOT NULL,
                prefix TEXT NOT NULL,
                next_number INTEGER NOT NULL,
                PRIMARY KEY (repo_id, prefix)
            );

            CREATE TABLE IF NOT EXISTS tag_stats (
                repo_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                seen_count INTEGER NOT NULL DEFAULT 0,
                up_count INTEGER NOT NULL DEFAULT 0,
                down_count INTEGER NOT NULL DEFAULT 0,
                last_seen_at TEXT,
                last_verified_at TEXT,
                PRIMARY KEY (repo_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                status TEXT NOT NULL,
                verified_at TEXT NOT NULL,
                files_json TEXT NOT NULL,
                notes TEXT,
                agent TEXT,
                source TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                branch TEXT NOT NULL,
                command TEXT NOT NULL,
                summary TEXT NOT NULL,
                build_time_s REAL,
                cited_up_json TEXT NOT NULL,
                cited_down_json TEXT NOT NULL,
                ts TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS selections (
                repo_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                last_selected_at TEXT,
                selection_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (repo_id, tag_id)
            );
            """
        )
        self.conn.commit()

    def _ensure_repo_profile(self) -> dict[str, Any]:
        repo_id = self.identity["repo_id"]
        display_name = self.identity["display_name"]
        now = now_iso()
        self.ensure_kb_repo()
        self._migrate_kb_repo_dirs()
        self._migrate_db_repo_state(now)
        self._migrate_overlay_state()
        row = self.conn.execute("SELECT * FROM repos WHERE repo_id = ?", (repo_id,)).fetchone()

        if row is None:
            self.conn.execute(
                """
                INSERT INTO repos (repo_id, root_path, display_name, output_dir, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (repo_id, str(self.repo_root), display_name, ".claude/rules", now, now),
            )
        else:
            self.conn.execute(
                "UPDATE repos SET root_path = ?, display_name = ?, updated_at = ? WHERE repo_id = ?",
                (str(self.repo_root), display_name, now, repo_id),
            )
        self.conn.commit()
        row = self.conn.execute("SELECT * FROM repos WHERE repo_id = ?", (repo_id,)).fetchone()
        profile = dict(row)
        self.profile = profile
        ensure_dir(self.canonical_repo_dir(profile))
        ensure_dir(self.canonical_rules_dir(profile))
        ensure_dir(self.overlay_root_dir(profile))
        self.ensure_repo_metadata(profile)
        self._reseed_repo_indexes()
        return profile

    def ensure_kb_repo(self) -> None:
        ensure_dir(self.kb_root)
        if not (self.kb_root / ".git").exists():
            subprocess.run(["git", "init", str(self.kb_root)], capture_output=True, check=False)
        readme = self.kb_root / "README.md"
        if not readme.exists():
            readme.write_text(
                "# proofd Knowledge Base\n\nCanonical structured rules for one or more code repositories.\n",
                encoding="utf-8",
            )

    def _legacy_repo_ids(self) -> list[str]:
        return legacy_repo_identifiers(self.repo_root, self.identity["slug"])

    def _matching_legacy_repo_dir_ids(self) -> list[str]:
        repos_dir = ensure_dir(self.kb_root / "repos")
        legacy_ids = set(self._legacy_repo_ids())
        exact_matches: list[str] = []
        fallback_matches: list[tuple[int, str]] = []
        for path in sorted(repos_dir.iterdir(), key=lambda item: item.name):
            if not path.is_dir() or path.name == self.identity["repo_id"]:
                continue
            metadata: dict[str, Any] = {}
            metadata_path = path / "repo.json"
            if metadata_path.exists():
                try:
                    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    metadata = {}
            candidate_key = normalize_repo_key((metadata.get("identity") or {}).get("repo_key"))
            rule_count = len(list((path / "rules").glob("*.json"))) if (path / "rules").exists() else 0
            if self.identity["repo_key"] and candidate_key == self.identity["repo_key"]:
                exact_matches.append(path.name)
                continue
            if path.name in legacy_ids:
                exact_matches.append(path.name)
                continue
            if metadata.get("display_name") == self.identity["display_name"] and path.name.startswith(self.identity["slug"] + "-"):
                fallback_matches.append((rule_count, path.name))
        if exact_matches:
            return sorted(dict.fromkeys(exact_matches))
        non_empty = [repo_id for rule_count, repo_id in fallback_matches if rule_count > 0]
        return non_empty if len(non_empty) == 1 else []

    def _merge_repo_dir(self, source_repo_id: str, target_repo_id: str) -> None:
        source_dir = self.kb_root / "repos" / source_repo_id
        target_dir = self.kb_root / "repos" / target_repo_id
        if not source_dir.exists() or source_dir.resolve() == target_dir.resolve():
            return
        ensure_dir(target_dir)
        ensure_dir(target_dir / "rules")

        source_metadata = source_dir / "repo.json"
        target_metadata = target_dir / "repo.json"
        if source_metadata.exists() and not target_metadata.exists():
            shutil.copy2(source_metadata, target_metadata)

        source_rules_dir = source_dir / "rules"
        if source_rules_dir.exists():
            for path in sorted(source_rules_dir.glob("*.json")):
                destination = target_dir / "rules" / path.name
                if destination.exists():
                    if destination.read_text(encoding="utf-8") != path.read_text(encoding="utf-8"):
                        raise RuntimeError(
                            f"Conflicting canonical rule while migrating proofd repo identity: {source_repo_id}/{path.name}"
                        )
                else:
                    shutil.copy2(path, destination)
        shutil.rmtree(source_dir, ignore_errors=True)

    def _migrate_kb_repo_dirs(self) -> None:
        for legacy_repo_id in self._matching_legacy_repo_dir_ids():
            self._merge_repo_dir(legacy_repo_id, self.identity["repo_id"])

    def _ensure_target_repo_row(self, repo_id: str, display_name: str, now: str, seed_row: sqlite3.Row | None = None) -> None:
        existing = self.conn.execute("SELECT 1 FROM repos WHERE repo_id = ?", (repo_id,)).fetchone()
        if existing is not None:
            return
        created_at = seed_row["created_at"] if seed_row is not None else now
        output_dir = seed_row["output_dir"] if seed_row is not None else ".claude/rules"
        self.conn.execute(
            """
            INSERT INTO repos (repo_id, root_path, display_name, output_dir, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (repo_id, str(self.repo_root), display_name, output_dir, created_at, now),
        )

    def _merge_prefix_registry(self, target_repo_id: str, legacy_repo_id: str) -> None:
        rows = self.conn.execute(
            "SELECT prefix, rule_id, title, created_at FROM prefix_registry WHERE repo_id = ?",
            (legacy_repo_id,),
        ).fetchall()
        for row in rows:
            self.conn.execute(
                """
                INSERT INTO prefix_registry (repo_id, prefix, rule_id, title, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(repo_id, prefix) DO NOTHING
                """,
                (target_repo_id, row["prefix"], row["rule_id"], row["title"], row["created_at"]),
            )
        self.conn.execute("DELETE FROM prefix_registry WHERE repo_id = ?", (legacy_repo_id,))

    def _merge_tag_counters(self, target_repo_id: str, legacy_repo_id: str) -> None:
        rows = self.conn.execute(
            "SELECT prefix, next_number FROM tag_counters WHERE repo_id = ?",
            (legacy_repo_id,),
        ).fetchall()
        for row in rows:
            self.conn.execute(
                """
                INSERT INTO tag_counters (repo_id, prefix, next_number)
                VALUES (?, ?, ?)
                ON CONFLICT(repo_id, prefix) DO UPDATE SET
                    next_number = CASE
                        WHEN tag_counters.next_number < excluded.next_number THEN excluded.next_number
                        ELSE tag_counters.next_number
                    END
                """,
                (target_repo_id, row["prefix"], row["next_number"]),
            )
        self.conn.execute("DELETE FROM tag_counters WHERE repo_id = ?", (legacy_repo_id,))

    def _merge_tag_stats(self, target_repo_id: str, legacy_repo_id: str) -> None:
        rows = self.conn.execute(
            """
            SELECT tag_id, seen_count, up_count, down_count, last_seen_at, last_verified_at
            FROM tag_stats
            WHERE repo_id = ?
            """,
            (legacy_repo_id,),
        ).fetchall()
        for row in rows:
            self.conn.execute(
                """
                INSERT INTO tag_stats (repo_id, tag_id, seen_count, up_count, down_count, last_seen_at, last_verified_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo_id, tag_id) DO UPDATE SET
                    seen_count = tag_stats.seen_count + excluded.seen_count,
                    up_count = tag_stats.up_count + excluded.up_count,
                    down_count = tag_stats.down_count + excluded.down_count,
                    last_seen_at = CASE
                        WHEN COALESCE(tag_stats.last_seen_at, '') >= COALESCE(excluded.last_seen_at, '') THEN tag_stats.last_seen_at
                        ELSE excluded.last_seen_at
                    END,
                    last_verified_at = CASE
                        WHEN COALESCE(tag_stats.last_verified_at, '') >= COALESCE(excluded.last_verified_at, '') THEN tag_stats.last_verified_at
                        ELSE excluded.last_verified_at
                    END
                """,
                (
                    target_repo_id,
                    row["tag_id"],
                    row["seen_count"],
                    row["up_count"],
                    row["down_count"],
                    row["last_seen_at"],
                    row["last_verified_at"],
                ),
            )
        self.conn.execute("DELETE FROM tag_stats WHERE repo_id = ?", (legacy_repo_id,))

    def _merge_selections(self, target_repo_id: str, legacy_repo_id: str) -> None:
        rows = self.conn.execute(
            "SELECT tag_id, last_selected_at, selection_count FROM selections WHERE repo_id = ?",
            (legacy_repo_id,),
        ).fetchall()
        for row in rows:
            self.conn.execute(
                """
                INSERT INTO selections (repo_id, tag_id, last_selected_at, selection_count)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(repo_id, tag_id) DO UPDATE SET
                    selection_count = selections.selection_count + excluded.selection_count,
                    last_selected_at = CASE
                        WHEN COALESCE(selections.last_selected_at, '') >= COALESCE(excluded.last_selected_at, '') THEN selections.last_selected_at
                        ELSE excluded.last_selected_at
                    END
                """,
                (target_repo_id, row["tag_id"], row["last_selected_at"], row["selection_count"]),
            )
        self.conn.execute("DELETE FROM selections WHERE repo_id = ?", (legacy_repo_id,))

    def _merge_overlay_dirs(self, target_repo_id: str, legacy_repo_id: str) -> None:
        source_dir = self.state_root / "overlays" / legacy_repo_id
        if not source_dir.exists():
            return
        target_dir = self.state_root / "overlays" / target_repo_id
        for path in sorted(source_dir.glob("*")):
            if path.is_dir():
                destination = target_dir / path.name
                ensure_dir(destination)
                for rule_path in sorted(path.glob("rules/*.json")):
                    rule_destination = destination / "rules" / rule_path.name
                    ensure_dir(rule_destination.parent)
                    if rule_destination.exists():
                        if rule_destination.read_text(encoding="utf-8") != rule_path.read_text(encoding="utf-8"):
                            raise RuntimeError(
                                f"Conflicting overlay rule while migrating proofd repo identity: {legacy_repo_id}/{path.name}/{rule_path.name}"
                            )
                    else:
                        shutil.copy2(rule_path, rule_destination)
        shutil.rmtree(source_dir, ignore_errors=True)

    def _migrate_db_repo_state(self, now: str) -> None:
        target_repo_id = self.identity["repo_id"]
        legacy_repo_ids = [
            repo_id
            for repo_id in self._legacy_repo_ids()
            if repo_id != target_repo_id and self.conn.execute("SELECT * FROM repos WHERE repo_id = ?", (repo_id,)).fetchone() is not None
        ]
        if not legacy_repo_ids:
            return

        seed_row = self.conn.execute("SELECT * FROM repos WHERE repo_id = ?", (legacy_repo_ids[0],)).fetchone()
        self._ensure_target_repo_row(target_repo_id, self.identity["display_name"], now, seed_row=seed_row)
        for legacy_repo_id in legacy_repo_ids:
            self._merge_prefix_registry(target_repo_id, legacy_repo_id)
            self._merge_tag_counters(target_repo_id, legacy_repo_id)
            self._merge_tag_stats(target_repo_id, legacy_repo_id)
            self.conn.execute("UPDATE verifications SET repo_id = ? WHERE repo_id = ?", (target_repo_id, legacy_repo_id))
            self.conn.execute("UPDATE runs SET repo_id = ? WHERE repo_id = ?", (target_repo_id, legacy_repo_id))
            self._merge_selections(target_repo_id, legacy_repo_id)
            self.conn.execute("DELETE FROM repos WHERE repo_id = ?", (legacy_repo_id,))
            self._merge_overlay_dirs(target_repo_id, legacy_repo_id)
        self.conn.execute(
            "UPDATE repos SET root_path = ?, display_name = ?, updated_at = ? WHERE repo_id = ?",
            (str(self.repo_root), self.identity["display_name"], now, target_repo_id),
        )
        self.conn.commit()

    def _migrate_overlay_state(self) -> None:
        target_repo_id = self.identity["repo_id"]
        for legacy_repo_id in self._legacy_repo_ids():
            if legacy_repo_id != target_repo_id:
                self._merge_overlay_dirs(target_repo_id, legacy_repo_id)

    def ensure_repo_metadata(self, profile: dict[str, Any]) -> dict[str, Any]:
        metadata_path = self.repo_metadata_path(profile)
        metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
        metadata["schema_version"] = SCHEMA_VERSION
        metadata["repo_id"] = profile["repo_id"]
        metadata["display_name"] = profile["display_name"]
        metadata["default_output_dir"] = profile["output_dir"]
        metadata.setdefault("default_batch_size", DEFAULT_BATCH_SIZE)
        metadata.setdefault("source_dirs", DEFAULT_SOURCE_DIRS)
        metadata.setdefault(
            "lint",
            {
                "split_suggest_threshold": 16,
                "heavy_context_threshold": 48,
                "global_rule_threshold": 16,
            },
        )
        identity = metadata.get("identity", {})
        aliases = {alias for alias in identity.get("aliases", []) if alias}
        if self.identity["repo_key"]:
            aliases.add(self.identity["repo_key"])
        metadata["identity"] = {
            "repo_key": self.identity["repo_key"],
            "origin_remote": self.identity["origin_remote"],
            "source": self.identity["identity_source"],
            "slug": self.identity["slug"],
            "aliases": sorted(aliases),
        }
        metadata_path.write_text(stable_json(metadata), encoding="utf-8")
        return metadata

    def repo_metadata(self) -> dict[str, Any]:
        return self.ensure_repo_metadata(self.profile)

    def _reseed_repo_indexes(self) -> None:
        branch = current_branch(self.repo_root)
        for rule in self.load_rules(branch).values():
            self._register_prefixes(rule)
            self._seed_counters_from_rule(rule)
        self.conn.commit()

    def canonical_repo_dir(self, profile: dict[str, Any] | None = None) -> pathlib.Path:
        profile = profile or self.profile
        return self.kb_root / "repos" / profile["repo_id"]

    def canonical_rules_dir(self, profile: dict[str, Any] | None = None) -> pathlib.Path:
        return self.canonical_repo_dir(profile) / "rules"

    def overlay_root_dir(self, profile: dict[str, Any] | None = None) -> pathlib.Path:
        profile = profile or self.profile
        return self.state_root / "overlays" / profile["repo_id"]

    def overlay_rules_dir(self, branch: str, profile: dict[str, Any] | None = None) -> pathlib.Path:
        profile = profile or self.profile
        safe_branch = slugify(branch) or "detached"
        return self.overlay_root_dir(profile) / safe_branch / "rules"

    def repo_metadata_path(self, profile: dict[str, Any] | None = None) -> pathlib.Path:
        profile = profile or self.profile
        return self.canonical_repo_dir(profile) / "repo.json"

    def output_rules_dir(self) -> pathlib.Path:
        return self.repo_root / self.profile["output_dir"]

    def canonical_rule_path(self, rule_id: str) -> pathlib.Path:
        return self.canonical_rules_dir() / f"{rule_id}.json"

    def overlay_rule_path(self, branch: str, rule_id: str) -> pathlib.Path:
        return self.overlay_rules_dir(branch) / f"{rule_id}.json"

    def save_rule(self, rule: dict[str, Any], layer: str = "workspace", branch: str | None = None) -> pathlib.Path:
        path = self.canonical_rule_path(rule["rule_id"]) if layer == "canonical" else self.overlay_rule_path(branch or current_branch(self.repo_root), rule["rule_id"])
        ensure_dir(path.parent)
        payload = copy.deepcopy(rule)
        payload["schema_version"] = SCHEMA_VERSION
        payload["entries"] = sorted_entries(payload.get("entries", []))
        path.write_text(stable_json(payload), encoding="utf-8")
        self._register_prefixes(payload)
        self._seed_counters_from_rule(payload)
        return path

    def delete_overlay(self, branch: str) -> int:
        overlay_dir = self.overlay_rules_dir(branch)
        if not overlay_dir.exists():
            return 0
        count = len(list(overlay_dir.glob("*.json")))
        shutil.rmtree(overlay_dir.parent, ignore_errors=True)
        return count

    def load_rules(self, branch: str | None = None) -> dict[str, dict[str, Any]]:
        rules: dict[str, dict[str, Any]] = {}
        for path in sorted(self.canonical_rules_dir().glob("*.json")):
            rules[path.stem] = json.loads(path.read_text(encoding="utf-8"))
        if branch:
            overlay_dir = self.overlay_rules_dir(branch)
            if overlay_dir.exists():
                for path in sorted(overlay_dir.glob("*.json")):
                    rules[path.stem] = json.loads(path.read_text(encoding="utf-8"))
        return rules

    def find_rule(self, rule_id: str, branch: str | None = None) -> dict[str, Any]:
        rules = self.load_rules(branch)
        if rule_id not in rules:
            raise KeyError(f"Rule not found: {rule_id}")
        return rules[rule_id]

    def find_entry(self, tag_id: str, branch: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        for rule in self.load_rules(branch).values():
            for entry in rule["entries"]:
                if entry["tag_id"] == tag_id:
                    return rule, entry
        raise KeyError(f"Tag not found: {tag_id}")

    def _register_prefixes(self, rule: dict[str, Any]) -> None:
        now = now_iso()
        prefixes = set(rule.get("known_prefixes", []))
        if rule.get("default_prefix"):
            prefixes.add(rule["default_prefix"])
        for entry in rule.get("entries", []):
            prefixes.add(entry["tag_id"].split("-", 1)[0])
        for prefix in prefixes:
            self.conn.execute(
                """
                INSERT INTO prefix_registry (repo_id, prefix, rule_id, title, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(repo_id, prefix) DO NOTHING
                """,
                (self.profile["repo_id"], prefix, rule["rule_id"], rule["title"], now),
            )
        self.conn.commit()

    def _seed_counters_from_rule(self, rule: dict[str, Any]) -> None:
        max_per_prefix: dict[str, int] = {}
        for entry in rule.get("entries", []):
            prefix, number = parse_tag_number(entry["tag_id"])
            max_per_prefix[prefix] = max(max_per_prefix.get(prefix, 0), number)
        for prefix, max_number in max_per_prefix.items():
            self.conn.execute(
                """
                INSERT INTO tag_counters (repo_id, prefix, next_number)
                VALUES (?, ?, ?)
                ON CONFLICT(repo_id, prefix) DO UPDATE SET
                    next_number = CASE
                        WHEN excluded.next_number > tag_counters.next_number THEN excluded.next_number
                        ELSE tag_counters.next_number
                    END
                """,
                (self.profile["repo_id"], prefix, max_number + 1),
            )
        self.conn.commit()

    def allocate_prefix(self, title: str, preferred: str | None = None) -> str:
        existing = {
            row["prefix"]
            for row in self.conn.execute(
                "SELECT prefix FROM prefix_registry WHERE repo_id = ?",
                (self.profile["repo_id"],),
            )
        }
        candidates = []
        if preferred:
            preferred = preferred.upper()
            if re.fullmatch(r"[A-Z]{2}", preferred):
                candidates.append(preferred)
        normalized_title = re.sub(r"[^A-Za-z ]+", " ", title).strip()
        words = [word.upper() for word in normalized_title.split() if word]
        if len(words) >= 2:
            candidates.append(words[0][0] + words[1][0])
        letters = "".join(words) or slugify(title).replace("-", "").upper()
        if len(letters) >= 2:
            candidates.append(letters[:2])
        for a, b in itertools.combinations(letters, 2):
            candidates.append(a + b)
        for a in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            for b in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                candidates.append(a + b)
        for candidate in candidates:
            if re.fullmatch(r"[A-Z]{2}", candidate) and candidate not in existing:
                return candidate
        raise RuntimeError("No prefix available")

    def allocate_tag(self, rule: dict[str, Any]) -> str:
        prefix = rule.get("default_prefix")
        if not prefix:
            prefix = self.allocate_prefix(rule["title"])
            rule["default_prefix"] = prefix
        with self.conn:
            row = self.conn.execute(
                "SELECT next_number FROM tag_counters WHERE repo_id = ? AND prefix = ?",
                (self.profile["repo_id"], prefix),
            ).fetchone()
            next_number = int(row["next_number"]) if row else 1
            while True:
                tag_id = f"{prefix}-{next_number:02d}" if next_number < 100 else f"{prefix}-{next_number:03d}"
                try:
                    self.find_entry(tag_id, current_branch(self.repo_root))
                    next_number += 1
                    continue
                except KeyError:
                    break
            self.conn.execute(
                """
                INSERT INTO tag_counters (repo_id, prefix, next_number)
                VALUES (?, ?, ?)
                ON CONFLICT(repo_id, prefix) DO UPDATE SET next_number = excluded.next_number
                """,
                (self.profile["repo_id"], prefix, next_number + 1),
            )
        self._register_prefixes(rule)
        return tag_id

    def scan_source_tags(self) -> dict[str, list[str]]:
        metadata = self.repo_metadata()
        source_dirs = metadata.get("source_dirs", DEFAULT_SOURCE_DIRS)
        hits: dict[str, list[str]] = {}
        for source_dir in source_dirs:
            root = self.repo_root / source_dir
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                if path.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx", ".rs", ".css", ".scss"}:
                    continue
                try:
                    content = path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    continue
                rel_path = normalize_path(str(path.relative_to(self.repo_root)))
                for match in SOURCE_TAG_RE.finditer(content):
                    tag_id = match.group(1)
                    hits.setdefault(tag_id, [])
                    if rel_path not in hits[tag_id]:
                        hits[tag_id].append(rel_path)
        return hits

    def create_rule(
        self,
        title: str,
        paths: list[str],
        summary: str = "",
        branch: str | None = None,
        layer: str = "workspace",
        rule_id: str | None = None,
        default_prefix: str | None = None,
    ) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        existing = self.load_rules(branch)
        final_rule_id = slugify(rule_id or title)
        if final_rule_id in existing:
            raise RuntimeError(f"Rule already exists: {final_rule_id}")
        prefix = self.allocate_prefix(title, preferred=default_prefix)
        rule = {
            "schema_version": SCHEMA_VERSION,
            "rule_id": final_rule_id,
            "title": title,
            "summary": summary.strip(),
            "load_policy": "auto",
            "scope": {"paths": [normalize_path(path) for path in paths]},
            "default_prefix": prefix,
            "known_prefixes": [prefix],
            "entries": [],
        }
        self.save_rule(rule, layer=layer, branch=branch)
        return rule

    def add_entry(
        self,
        rule_id: str,
        statement: str,
        files: list[str],
        details: list[str] | None = None,
        branch: str | None = None,
        layer: str = "workspace",
    ) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        rule = copy.deepcopy(self.find_rule(rule_id, branch=branch))
        tag_id = self.allocate_tag(rule)
        entry = {
            "tag_id": tag_id,
            "statement": statement.strip(),
            "anchors": [{"path": normalize_anchor_path(file_path)} for file_path in files],
            "details": details or [],
            "notes": [],
            "prefix": tag_id.split("-", 1)[0],
        }
        rule["entries"].append(entry)
        rule["known_prefixes"] = sorted(set(rule.get("known_prefixes", [])) | {entry["prefix"]})
        self.save_rule(rule, layer=layer, branch=branch)
        self.upsert_tag_stats(tag_id)
        return entry

    def update_entry(
        self,
        tag_id: str,
        statement: str | None = None,
        files: list[str] | None = None,
        details: list[str] | None = None,
        branch: str | None = None,
        layer: str = "workspace",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        branch = branch or current_branch(self.repo_root)
        rule, _ = self.find_entry(tag_id, branch=branch)
        rule = copy.deepcopy(rule)
        mutable_entry = entry_index(rule, tag_id)
        if mutable_entry is None:
            raise RuntimeError(f"Could not reload tag {tag_id}")
        if statement is not None:
            mutable_entry["statement"] = statement.strip()
        if files is not None:
            normalized_files = [normalize_anchor_path(file_path) for file_path in files]
            mutable_entry["anchors"] = [{"path": file_path} for file_path in normalized_files]
            if details is None:
                mutable_entry["details"] = [
                    detail for detail in mutable_entry.get("details", [])
                    if not detail.lower().startswith("files:")
                ]
        if details is not None:
            mutable_entry["details"] = details
        self.save_rule(rule, layer=layer, branch=branch)
        return rule, mutable_entry

    def entry_files(self, tag_id: str, branch: str | None = None) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        rule, entry = self.find_entry(tag_id, branch=branch)
        anchors = [anchor["path"] for anchor in entry.get("anchors", []) if anchor.get("path")]
        source_hits = self.scan_source_tags().get(tag_id, [])
        return {
            "tag_id": tag_id,
            "rule_id": rule["rule_id"],
            "files": anchors,
            "source_hits": source_hits,
        }

    def delete_entry(
        self,
        tag_id: str,
        branch: str | None = None,
        layer: str = "workspace",
    ) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        rule, existing_entry = self.find_entry(tag_id, branch=branch)
        rule = copy.deepcopy(rule)
        remaining_entries = [entry for entry in rule["entries"] if entry["tag_id"] != tag_id]
        if len(remaining_entries) == len(rule["entries"]):
            raise RuntimeError(f"Could not reload tag {tag_id}")
        rule["entries"] = remaining_entries
        known_prefixes = {rule.get("default_prefix")}
        known_prefixes.update(entry.get("prefix") or entry["tag_id"].split("-", 1)[0] for entry in remaining_entries)
        rule["known_prefixes"] = sorted(prefix for prefix in known_prefixes if prefix)
        self.save_rule(rule, layer=layer, branch=branch)
        self.conn.execute("DELETE FROM tag_stats WHERE repo_id = ? AND tag_id = ?", (self.profile["repo_id"], tag_id))
        self.conn.execute("DELETE FROM verifications WHERE repo_id = ? AND tag_id = ?", (self.profile["repo_id"], tag_id))
        self.conn.execute("DELETE FROM selections WHERE repo_id = ? AND tag_id = ?", (self.profile["repo_id"], tag_id))
        self.conn.commit()
        return {
            "rule_id": rule["rule_id"],
            "tag_id": tag_id,
            "deleted_entry": existing_entry,
            "remaining_entries": len(remaining_entries),
        }

    def split_rule(
        self,
        rule_id: str,
        new_title: str,
        tags: list[str],
        new_rule_id: str | None = None,
        new_paths: list[str] | None = None,
        branch: str | None = None,
        layer: str = "workspace",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        branch = branch or current_branch(self.repo_root)
        original = copy.deepcopy(self.find_rule(rule_id, branch=branch))
        moved = [entry for entry in original["entries"] if entry["tag_id"] in set(tags)]
        if not moved:
            raise RuntimeError("No matching entries to move")
        original["entries"] = [entry for entry in original["entries"] if entry["tag_id"] not in set(tags)]
        new_rule = self.create_rule(
            title=new_title,
            paths=new_paths if new_paths is not None else original.get("scope", {}).get("paths", []),
            summary="",
            branch=branch,
            layer=layer,
            rule_id=new_rule_id,
        )
        new_rule = copy.deepcopy(new_rule)
        new_rule["entries"] = moved
        existing_prefixes = set(new_rule.get("known_prefixes", []))
        existing_prefixes.update(entry["tag_id"].split("-", 1)[0] for entry in moved)
        new_rule["known_prefixes"] = sorted(existing_prefixes)
        self.save_rule(original, layer=layer, branch=branch)
        self.save_rule(new_rule, layer=layer, branch=branch)
        return original, new_rule

    def upsert_tag_stats(
        self,
        tag_id: str,
        seen_delta: int = 0,
        up_delta: int = 0,
        down_delta: int = 0,
        last_seen_at: str | None = None,
        last_verified_at: str | None = None,
    ) -> None:
        row = self.conn.execute(
            "SELECT seen_count, up_count, down_count, last_seen_at, last_verified_at FROM tag_stats WHERE repo_id = ? AND tag_id = ?",
            (self.profile["repo_id"], tag_id),
        ).fetchone()
        if row:
            seen = int(row["seen_count"]) + seen_delta
            up = int(row["up_count"]) + up_delta
            down = int(row["down_count"]) + down_delta
            seen_at = last_seen_at or row["last_seen_at"]
            verified_at = last_verified_at or row["last_verified_at"]
            self.conn.execute(
                """
                UPDATE tag_stats
                SET seen_count = ?, up_count = ?, down_count = ?, last_seen_at = ?, last_verified_at = ?
                WHERE repo_id = ? AND tag_id = ?
                """,
                (seen, up, down, seen_at, verified_at, self.profile["repo_id"], tag_id),
            )
        else:
            self.conn.execute(
                """
                INSERT INTO tag_stats (repo_id, tag_id, seen_count, up_count, down_count, last_seen_at, last_verified_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    self.profile["repo_id"],
                    tag_id,
                    seen_delta,
                    up_delta,
                    down_delta,
                    last_seen_at,
                    last_verified_at,
                ),
            )
        self.conn.commit()

    def stats_for_tag(self, tag_id: str) -> dict[str, Any]:
        row = self.conn.execute(
            "SELECT * FROM tag_stats WHERE repo_id = ? AND tag_id = ?",
            (self.profile["repo_id"], tag_id),
        ).fetchone()
        return dict(row) if row else {
            "repo_id": self.profile["repo_id"],
            "tag_id": tag_id,
            "seen_count": 0,
            "up_count": 0,
            "down_count": 0,
            "last_seen_at": None,
            "last_verified_at": None,
        }

    def record_verification(
        self,
        tag_id: str,
        status: str,
        files: list[str],
        notes: str | None,
        agent: str | None = None,
        source: str = "manual",
        update_anchors: bool = False,
        branch: str | None = None,
        layer: str = "workspace",
    ) -> dict[str, Any]:
        verified_at = now_iso()
        normalized_files = [normalize_anchor_path(file_path) for file_path in files]
        self.conn.execute(
            """
            INSERT INTO verifications (repo_id, tag_id, status, verified_at, files_json, notes, agent, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                self.profile["repo_id"],
                tag_id,
                status,
                verified_at,
                json.dumps(normalized_files),
                notes,
                agent,
                source,
            ),
        )
        self.conn.commit()
        self.upsert_tag_stats(tag_id, last_verified_at=verified_at)

        rule, _ = self.find_entry(tag_id, branch=branch or current_branch(self.repo_root))
        if update_anchors and normalized_files:
            self.update_entry(tag_id, files=normalized_files, branch=branch, layer=layer)
        return {
            "tag_id": tag_id,
            "rule_id": rule["rule_id"],
            "status": status,
            "verified_at": verified_at,
            "files": normalized_files,
            "notes": notes,
        }

    def record_citations(self, tags: list[str], command: str = "manual", direction: str = "up") -> dict[str, Any]:
        if direction not in {"up", "down"}:
            raise RuntimeError("direction must be up or down")
        timestamp = now_iso()
        for tag_id in tags:
            if direction == "up":
                self.upsert_tag_stats(tag_id, up_delta=1, last_seen_at=timestamp)
            else:
                self.upsert_tag_stats(tag_id, down_delta=1, last_seen_at=timestamp)
        return {"tags": tags, "direction": direction, "command": command, "ts": timestamp}

    def log_run(
        self,
        command: str,
        summary: str,
        build_time_s: float | None,
        cited_up: list[str],
        cited_down: list[str],
        branch: str | None = None,
    ) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        run_id = str(uuid.uuid4())
        timestamp = now_iso()
        self.conn.execute(
            """
            INSERT INTO runs (run_id, repo_id, branch, command, summary, build_time_s, cited_up_json, cited_down_json, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                self.profile["repo_id"],
                branch,
                command,
                summary.strip(),
                build_time_s,
                json.dumps(cited_up),
                json.dumps(cited_down),
                timestamp,
            ),
        )
        self.conn.commit()
        all_tags = {entry["tag_id"] for rule in self.load_rules(branch).values() for entry in rule["entries"]}
        for tag_id in sorted(all_tags):
            self.upsert_tag_stats(tag_id, seen_delta=1, last_seen_at=timestamp)
        if cited_up:
            self.record_citations(cited_up, command=command, direction="up")
        if cited_down:
            self.record_citations(cited_down, command=command, direction="down")
        return {"run_id": run_id, "ts": timestamp}

    def recent_runs(self, limit: int = 5) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM runs WHERE repo_id = ? ORDER BY ts DESC LIMIT ?",
            (self.profile["repo_id"], limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def status(self) -> dict[str, Any]:
        branch = current_branch(self.repo_root)
        overlay_dir = self.overlay_rules_dir(branch)
        overlay_count = len(list(overlay_dir.glob("*.json"))) if overlay_dir.exists() else 0
        return {
            "repo_id": self.profile["repo_id"],
            "repo_key": self.identity["repo_key"],
            "identity_source": self.identity["identity_source"],
            "repo_root": str(self.repo_root),
            "kb_root": str(self.kb_root),
            "state_db": str(self.db_path),
            "branch": branch,
            "default_branch": default_branch(self.repo_root),
            "overlay_rules": overlay_count,
            "recent_runs": self.recent_runs(),
        }

    def promote_overlay(self, branch: str | None = None) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        overlay_dir = self.overlay_rules_dir(branch)
        if not overlay_dir.exists():
            return {"branch": branch, "promoted": 0}
        promoted = 0
        for path in sorted(overlay_dir.glob("*.json")):
            destination = self.canonical_rule_path(path.stem)
            ensure_dir(destination.parent)
            shutil.copy2(path, destination)
            promoted += 1
        self.delete_overlay(branch)
        return {"branch": branch, "promoted": promoted}

    def import_legacy(self, legacy_rules_dir: pathlib.Path, legacy_proofs_dir: pathlib.Path, sync_after: bool = False) -> dict[str, Any]:
        legacy_rules_dir = legacy_rules_dir.resolve()
        legacy_proofs_dir = legacy_proofs_dir.resolve()
        if not legacy_rules_dir.exists():
            raise RuntimeError(f"Legacy rules dir not found: {legacy_rules_dir}")

        self.conn.execute("DELETE FROM prefix_registry WHERE repo_id = ?", (self.profile["repo_id"],))
        self.conn.execute("DELETE FROM tag_counters WHERE repo_id = ?", (self.profile["repo_id"],))
        self.conn.execute("DELETE FROM tag_stats WHERE repo_id = ?", (self.profile["repo_id"],))
        self.conn.execute("DELETE FROM verifications WHERE repo_id = ?", (self.profile["repo_id"],))
        self.conn.execute("DELETE FROM runs WHERE repo_id = ?", (self.profile["repo_id"],))
        self.conn.execute("DELETE FROM selections WHERE repo_id = ?", (self.profile["repo_id"],))
        self.conn.commit()

        for path in self.canonical_rules_dir().glob("*.json"):
            path.unlink()

        rules_imported = 0
        tags_imported = 0
        orphan_metadata: list[str] = []

        for markdown_path in sorted(legacy_rules_dir.glob("*.md")):
            rule = parse_rule_markdown(markdown_path)
            proof_path = legacy_proofs_dir / f"prove-{markdown_path.stem}.json"
            proof_state = json.loads(proof_path.read_text(encoding="utf-8")) if proof_path.exists() else {}
            metadata = proof_state.get("metadata", {})
            citations = proof_state.get("citations", {})

            for entry in rule["entries"]:
                tag_id = entry["tag_id"]
                tags_imported += 1
                imported_meta = metadata.get(tag_id, {})
                imported_notes = imported_meta.get("notes", [])
                if isinstance(imported_notes, str):
                    imported_notes = [{"date": imported_meta.get("verified"), "text": imported_notes}]
                entry["notes"] = [note for note in imported_notes if note]
                if imported_meta.get("files") and not entry.get("anchors"):
                    normalized_files = [normalize_anchor_path(file_path) for file_path in imported_meta["files"]]
                    entry["anchors"] = [{"path": file_path} for file_path in normalized_files]
                counts = citations.get(tag_id, {})
                self.upsert_tag_stats(
                    tag_id,
                    seen_delta=int(counts.get("seen", 0)),
                    up_delta=int(counts.get("up", 0)),
                    down_delta=int(counts.get("down", 0)),
                    last_verified_at=imported_meta.get("verified"),
                )
                if imported_meta.get("verified"):
                    self.conn.execute(
                        """
                        INSERT INTO verifications (repo_id, tag_id, status, verified_at, files_json, notes, agent, source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            self.profile["repo_id"],
                            tag_id,
                            "imported",
                            imported_meta["verified"],
                            json.dumps([anchor["path"] for anchor in entry.get("anchors", [])]),
                            "Imported from legacy proofs metadata",
                            "proofd-import",
                            "legacy-import",
                        ),
                    )
                    self.conn.commit()
            for stray_tag in sorted(set(metadata.keys()) - {entry["tag_id"] for entry in rule["entries"]}):
                orphan_metadata.append(f"{markdown_path.stem}:{stray_tag}")

            rule["legacy"]["source_markdown"] = normalize_path(str(markdown_path.relative_to(self.repo_root)))
            if proof_path.exists():
                rule["legacy"]["source_state"] = normalize_path(str(proof_path.relative_to(self.repo_root)))
            self.save_rule(rule, layer="canonical")
            rules_imported += 1

        runs_path = legacy_proofs_dir / "runs.jsonl"
        imported_runs = 0
        if runs_path.exists():
            for raw_line in runs_path.read_text(encoding="utf-8").splitlines():
                if not raw_line.strip():
                    continue
                try:
                    payload = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                self.conn.execute(
                    """
                    INSERT OR IGNORE INTO runs (run_id, repo_id, branch, command, summary, build_time_s, cited_up_json, cited_down_json, ts)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        self.profile["repo_id"],
                        current_branch(self.repo_root),
                        payload.get("cmd", "legacy"),
                        payload.get("summary", "Imported legacy run"),
                        payload.get("build_time_s"),
                        json.dumps(payload.get("cited", {}).get("up", [])),
                        json.dumps(payload.get("cited", {}).get("down", [])),
                        payload.get("ts", now_iso()),
                    ),
                )
                imported_runs += 1
            self.conn.commit()

        if sync_after:
            self.sync_rules()

        return {
            "rules_imported": rules_imported,
            "tags_imported": tags_imported,
            "runs_imported": imported_runs,
            "orphan_metadata": orphan_metadata,
        }

    def render_rule_markdown(self, rule: dict[str, Any]) -> str:
        frontmatter = {}
        paths = [normalize_path(path) for path in rule.get("scope", {}).get("paths", [])]
        if paths:
            frontmatter["paths"] = paths

        lines = []
        lines.append(f"# {rule['title']}")
        lines.append("")
        lines.append(f"<!-- Generated by proofd. Rule ID: {rule['rule_id']}. Do not edit manually. -->")
        if rule.get("default_prefix"):
            known_prefixes = ", ".join(rule.get("known_prefixes", []))
            lines.append(f"<!-- Default Prefix: {rule['default_prefix']} | Prefixes: {known_prefixes} -->")
        if rule.get("summary"):
            lines.append("")
            lines.extend(rule["summary"].splitlines())
        if rule.get("entries"):
            lines.append("")
            for entry in sorted_entries(rule["entries"]):
                lines.append(f"- [{entry['tag_id']}] {entry['statement']}")
                non_file_details = [detail for detail in entry.get("details", []) if not detail.lower().startswith("files:")]
                for detail in non_file_details:
                    lines.append(f"  - {detail}")
        else:
            lines.append("")
            lines.append("_No entries yet._")
        return render_frontmatter(frontmatter) + "\n".join(lines).rstrip() + "\n"

    def sync_rules(self, branch: str | None = None, clean: bool = True) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        rules = self.load_rules(branch)
        output_dir = ensure_dir(self.output_rules_dir())
        manifest_path = output_dir / ".proofd-manifest.json"
        previous_manifest = []
        if manifest_path.exists():
            try:
                previous_manifest = json.loads(manifest_path.read_text(encoding="utf-8")).get("files", [])
            except json.JSONDecodeError:
                previous_manifest = []

        generated_files = []
        for rule_id, rule in sorted(rules.items()):
            path = output_dir / f"{rule_id}.md"
            content = self.render_rule_markdown(rule)
            path.write_text(content, encoding="utf-8")
            generated_files.append(path.name)

        if clean:
            for file_name in previous_manifest:
                if file_name not in generated_files:
                    stale_path = output_dir / file_name
                    if stale_path.exists():
                        stale_path.unlink()

        manifest_path.write_text(stable_json({"branch": branch, "files": sorted(generated_files)}), encoding="utf-8")
        return {"generated": len(generated_files), "output_dir": str(output_dir), "branch": branch}

    def context(self, paths: list[str], branch: str | None = None, format_name: str = "markdown") -> str:
        branch = branch or current_branch(self.repo_root)
        normalized_paths = [normalize_path(path) for path in paths]
        rules = self.load_rules(branch)
        source_hits = self.scan_source_tags()
        matched: list[tuple[int, dict[str, Any], list[dict[str, Any]]]] = []
        for rule in rules.values():
            scope_paths = rule.get("scope", {}).get("paths", [])
            if scope_paths and not any(file_matches(path, scope_paths) for path in normalized_paths):
                continue
            anchored_entries = []
            for entry in rule["entries"]:
                exact_anchor = any(anchor.get("path") in normalized_paths for anchor in entry.get("anchors", []))
                source_anchor = any(path in source_hits.get(entry["tag_id"], []) for path in normalized_paths)
                score = (20 if exact_anchor else 0) + (10 if source_anchor else 0)
                anchored_entries.append((score, entry))
            anchored_entries.sort(key=lambda item: (-item[0], parse_tag_number(item[1]["tag_id"])))
            matched.append((len(scope_paths), rule, [entry for _, entry in anchored_entries]))
        matched.sort(key=lambda item: (item[0] == 0, item[0], item[1]["title"]))

        if format_name == "json":
            payload = [
                {
                    "rule_id": rule["rule_id"],
                    "title": rule["title"],
                    "paths": rule.get("scope", {}).get("paths", []),
                    "entries": entries,
                }
                for _, rule, entries in matched
            ]
            return stable_json(payload)

        output: list[str] = [f"# Context for {', '.join(normalized_paths)}"]
        for _, rule, entries in matched:
            output.append("")
            output.append(f"## {rule['title']} ({rule['rule_id']})")
            if rule.get("summary"):
                output.append(rule["summary"])
            for entry in entries:
                output.append(f"- [{entry['tag_id']}] {entry['statement']}")
                for detail in [detail for detail in entry.get("details", []) if not detail.lower().startswith("files:")]:
                    output.append(f"  - {detail}")
        if len(output) == 1:
            output.extend(["", "_No matching rules._"])
        return "\n".join(output) + "\n"

    def select_matching(self, changed_paths: list[str], batch_size: int | None = None, branch: str | None = None) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        batch_size = batch_size or int(self.repo_metadata().get("default_batch_size", DEFAULT_BATCH_SIZE))
        normalized_paths = [normalize_path(path) for path in changed_paths]
        rules = self.load_rules(branch)
        candidates: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
        for rule in rules.values():
            scope_paths = rule.get("scope", {}).get("paths", [])
            if scope_paths and not any(file_matches(path, scope_paths) for path in normalized_paths):
                continue
            for entry in rule["entries"]:
                stats = self.stats_for_tag(entry["tag_id"])
                selection = self.conn.execute(
                    "SELECT last_selected_at, selection_count FROM selections WHERE repo_id = ? AND tag_id = ?",
                    (self.profile["repo_id"], entry["tag_id"]),
                ).fetchone()
                score = 0.0
                if not stats["last_verified_at"]:
                    score += 1000.0
                else:
                    verified_at = parse_datetime_any(str(stats["last_verified_at"]))
                    if verified_at is None:
                        age_days = 0
                    else:
                        age_days = (datetime.now(timezone.utc) - verified_at).days
                    score += min(max(age_days, 0), 365)
                anchor_paths = {anchor["path"] for anchor in entry.get("anchors", []) if anchor.get("path")}
                if anchor_paths & set(normalized_paths):
                    score += 25.0
                score += max(0, 5 - int(stats["seen_count"]))
                if selection and selection["selection_count"]:
                    score -= min(selection["selection_count"], 5)
                score += random.random() * 0.01
                candidates.append((score, rule, entry))

        candidates.sort(key=lambda item: (-item[0], item[2]["tag_id"]))
        selected = candidates[:batch_size]
        timestamp = now_iso()
        grouped: dict[str, list[dict[str, Any]]] = {}
        for _, rule, entry in selected:
            grouped.setdefault(rule["rule_id"], []).append(entry)
            self.conn.execute(
                """
                INSERT INTO selections (repo_id, tag_id, last_selected_at, selection_count)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(repo_id, tag_id) DO UPDATE SET
                    last_selected_at = excluded.last_selected_at,
                    selection_count = selections.selection_count + 1
                """,
                (self.profile["repo_id"], entry["tag_id"], timestamp),
            )
        self.conn.commit()
        return {
            "branch": branch,
            "changed_paths": normalized_paths,
            "selected": [{"rule_id": rule["rule_id"], "title": rule["title"], "entry": entry} for _, rule, entry in selected],
            "grouped": grouped,
        }

    def lint(self, branch: str | None = None) -> dict[str, Any]:
        branch = branch or current_branch(self.repo_root)
        rules = self.load_rules(branch)
        metadata = self.repo_metadata()
        lint_config = metadata.get("lint", {})
        split_threshold = int(lint_config.get("split_suggest_threshold", 16))
        heavy_context = int(lint_config.get("heavy_context_threshold", 48))
        warnings: list[str] = []
        entries_by_tag: dict[str, str] = {}
        source_hits = self.scan_source_tags()

        tracked_files: list[str] = []
        for source_dir in metadata.get("source_dirs", DEFAULT_SOURCE_DIRS):
            root = self.repo_root / source_dir
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.is_file():
                    tracked_files.append(normalize_path(str(path.relative_to(self.repo_root))))

        for rule in sorted(rules.values(), key=lambda item: item["rule_id"]):
            entry_count = len(rule["entries"])
            if entry_count > split_threshold:
                warnings.append(
                    f"SPLIT SUGGESTION: {rule['rule_id']} has {entry_count} entries. Consider splitting by topic, even if the scope paths stay the same."
                )
            paths = rule.get("scope", {}).get("paths", [])
            if paths:
                for pattern in paths:
                    if not any(file_matches(file_path, [pattern]) for file_path in tracked_files):
                        warnings.append(f"STALE PATH: {rule['rule_id']} pattern '{pattern}' matches no tracked source file")
            for entry in rule["entries"]:
                tag_id = entry["tag_id"]
                if tag_id in entries_by_tag:
                    warnings.append(f"DUPLICATE TAG: {tag_id} appears in both {entries_by_tag[tag_id]} and {rule['rule_id']}")
                entries_by_tag[tag_id] = rule["rule_id"]
                anchors = [anchor["path"] for anchor in entry.get("anchors", []) if anchor.get("path")]
                if not anchors and tag_id not in source_hits:
                    warnings.append(f"UNANCHORED ENTRY: {tag_id} in {rule['rule_id']} has no anchors and no source-code tag hit")
                non_file_details = [detail for detail in entry.get("details", []) if not detail.lower().startswith("files:")]
                if entry.get("statement", "").strip().endswith(":") and not non_file_details:
                    warnings.append(f"SUSPICIOUS ENTRY: {tag_id} in {rule['rule_id']} ends with ':' but has no supporting details")

        for tag_id, paths in sorted(source_hits.items()):
            if tag_id not in entries_by_tag:
                warnings.append(f"ORPHAN SOURCE TAG: {tag_id} appears in source but not in proofd rules ({', '.join(paths)})")

        per_file_tag_load: dict[str, int] = {}
        for file_path in tracked_files:
            total = 0
            for rule in rules.values():
                paths = rule.get("scope", {}).get("paths", [])
                if not paths or file_matches(file_path, paths):
                    total += len(rule["entries"])
            per_file_tag_load[file_path] = total
        for file_path, total in sorted(per_file_tag_load.items(), key=lambda item: item[1], reverse=True)[:25]:
            if total > heavy_context:
                warnings.append(f"HEAVY AUTO-LOAD: {file_path} surfaces {total} tags. This is allowed, but consider more concise statements or additional rule files.")

        global_tags = sum(len(rule["entries"]) for rule in rules.values() if not rule.get("scope", {}).get("paths"))
        if global_tags > int(lint_config.get("global_rule_threshold", 16)):
            warnings.append(
                f"GLOBAL CONTEXT: global rules expose {global_tags} tags. Keep them concise, but surfacing them globally is still permitted."
            )

        return {"branch": branch, "warnings": warnings}

    def review_brief(self, intent: str, approach: str, limitations: str | None, alternatives: str | None) -> str:
        changed_files = git_output(["diff", "HEAD", "--stat"], self.repo_root) or "(no git diff available)"
        diff = git_output(["diff", "HEAD"], self.repo_root) or ""
        sections = [
            "## Review Brief",
            "",
            "### Intent",
            intent.strip(),
            "",
            "### Approach",
            approach.strip(),
        ]
        if limitations:
            sections.extend(["", "### Limitations", limitations.strip()])
        if alternatives:
            sections.extend(["", "### Alternatives Considered", alternatives.strip()])
        sections.extend(["", "### Changed Files", changed_files, "", "### Diff", "```diff", diff, "```"])
        return "\n".join(sections) + "\n"


def format_select_matching(selection: dict[str, Any]) -> str:
    selected = selection["selected"]
    grouped = selection["grouped"]
    lines = []
    lines.append(f"Selected {len(selected)} entries for branch {selection['branch']}.")
    lines.append(f"Changed paths: {', '.join(selection['changed_paths'])}")
    lines.append("")
    for rule_id, entries in sorted(grouped.items()):
        lines.append(f"RULE: {rule_id} ({len(entries)} entries)")
        for entry in sorted_entries(entries):
            lines.append(f"  {entry['tag_id']}")
    lines.append("")
    lines.append("--- ENTRIES ---")
    for item in selected:
        rule_id = item["rule_id"]
        entry = item["entry"]
        lines.append(f"[{entry['tag_id']}] ({rule_id})")
        lines.append(f"- [{entry['tag_id']}] {entry['statement']}")
        for detail in [detail for detail in entry.get("details", []) if not detail.lower().startswith("files:")]:
            lines.append(f"  - {detail}")
        anchor_paths = [anchor["path"] for anchor in entry.get("anchors", []) if anchor.get("path")]
        if anchor_paths:
            lines.append(f"  - Files: {', '.join(anchor_paths)}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def print_json(data: Any) -> None:
    print(stable_json(data), end="")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="proofd CLI")
    parser.add_argument("--repo-root", default=".", help="Repo root or any path inside the repo")
    parser.add_argument("--state-root", default=None, help="Override proofd state root")
    parser.add_argument("--kb-root", default=None, help="Override proofd knowledge-base root")
    parser.add_argument("--repo-key", default=None, help="Stable repo identity override; defaults to normalized remote.origin.url")

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("status")

    init_parser = subparsers.add_parser("init")
    init_parser.add_argument("--json", action="store_true")

    import_parser = subparsers.add_parser("import-legacy")
    import_parser.add_argument("--legacy-rules-dir", default=".claude/rules")
    import_parser.add_argument("--legacy-proofs-dir", default=".proofs")
    import_parser.add_argument("--sync", action="store_true")
    import_parser.add_argument("--json", action="store_true")

    sync_parser = subparsers.add_parser("sync")
    sync_parser.add_argument("--branch", default=None)
    sync_parser.add_argument("--json", action="store_true")

    lint_parser = subparsers.add_parser("lint")
    lint_parser.add_argument("--branch", default=None)
    lint_parser.add_argument("--json", action="store_true")

    context_parser = subparsers.add_parser("context")
    context_parser.add_argument("paths", nargs="+")
    context_parser.add_argument("--branch", default=None)
    context_parser.add_argument("--format", choices=["markdown", "json"], default="markdown")

    entry_files_parser = subparsers.add_parser("entry-files")
    entry_files_parser.add_argument("--tag", required=True)
    entry_files_parser.add_argument("--branch", default=None)
    entry_files_parser.add_argument("--format", choices=["markdown", "json"], default="markdown")

    select_parser = subparsers.add_parser("select-matching")
    select_parser.add_argument("paths", nargs="+")
    select_parser.add_argument("--batch-size", type=int, default=None)
    select_parser.add_argument("--branch", default=None)
    select_parser.add_argument("--json", action="store_true")

    create_rule_parser = subparsers.add_parser("create-rule")
    create_rule_parser.add_argument("--title", required=True)
    create_rule_parser.add_argument("--paths", required=True, help="Comma-separated path globs")
    create_rule_parser.add_argument("--summary", default="")
    create_rule_parser.add_argument("--rule-id", default=None)
    create_rule_parser.add_argument("--canonical", action="store_true")
    create_rule_parser.add_argument("--json", action="store_true")

    allocate_parser = subparsers.add_parser("allocate-tag")
    allocate_parser.add_argument("--rule", required=True)
    allocate_parser.add_argument("--branch", default=None)
    allocate_parser.add_argument("--json", action="store_true")

    add_entry_parser = subparsers.add_parser("add-entry")
    add_entry_parser.add_argument("--rule", required=True)
    add_entry_parser.add_argument("--statement", required=True)
    add_entry_parser.add_argument("--files", required=True, help="Comma-separated file paths")
    add_entry_parser.add_argument("--detail", action="append", default=[])
    add_entry_parser.add_argument("--canonical", action="store_true")
    add_entry_parser.add_argument("--json", action="store_true")

    update_entry_parser = subparsers.add_parser("update-entry")
    update_entry_parser.add_argument("--tag", required=True)
    update_entry_parser.add_argument("--statement", default=None)
    update_entry_parser.add_argument("--files", default=None, help="Comma-separated file paths")
    update_entry_parser.add_argument("--detail", action="append", default=None)
    update_entry_parser.add_argument("--canonical", action="store_true")
    update_entry_parser.add_argument("--json", action="store_true")

    delete_entry_parser = subparsers.add_parser("delete-entry")
    delete_entry_parser.add_argument("--tag", required=True)
    delete_entry_parser.add_argument("--canonical", action="store_true")
    delete_entry_parser.add_argument("--json", action="store_true")

    split_parser = subparsers.add_parser("split-rule")
    split_parser.add_argument("--rule", required=True)
    split_parser.add_argument("--new-title", required=True)
    split_parser.add_argument("--tags", required=True, help="Comma-separated tag ids")
    split_parser.add_argument("--new-rule-id", default=None)
    split_parser.add_argument("--paths", default=None, help="Optional comma-separated replacement paths")
    split_parser.add_argument("--canonical", action="store_true")
    split_parser.add_argument("--json", action="store_true")

    verify_parser = subparsers.add_parser("record-verification")
    verify_parser.add_argument("--tag", required=True)
    verify_parser.add_argument("--status", required=True)
    verify_parser.add_argument("--files", required=True, help="Comma-separated file paths")
    verify_parser.add_argument("--notes", default=None)
    verify_parser.add_argument("--agent", default=None)
    verify_parser.add_argument("--source", default="manual")
    verify_parser.add_argument("--update-anchors", action="store_true")
    verify_parser.add_argument("--canonical", action="store_true")
    verify_parser.add_argument("--json", action="store_true")

    citations_parser = subparsers.add_parser("record-citations")
    citations_parser.add_argument("--tags", required=True, help="Comma-separated tag ids")
    citations_parser.add_argument("--command-name", default="manual")
    citations_parser.add_argument("--direction", choices=["up", "down"], default="up")
    citations_parser.add_argument("--json", action="store_true")

    log_parser = subparsers.add_parser("log-run")
    log_parser.add_argument("--cmd", required=True)
    log_parser.add_argument("--summary", required=True)
    log_parser.add_argument("--build-time", default=None)
    log_parser.add_argument("--cited-up", default="")
    log_parser.add_argument("--cited-down", default="")
    log_parser.add_argument("--json", action="store_true")

    review_parser = subparsers.add_parser("review-brief")
    review_parser.add_argument("--intent", required=True)
    review_parser.add_argument("--approach", required=True)
    review_parser.add_argument("--limitations", default=None)
    review_parser.add_argument("--alternatives", default=None)

    promote_parser = subparsers.add_parser("promote-overlay")
    promote_parser.add_argument("--branch", default=None)
    promote_parser.add_argument("--json", action="store_true")

    mcp_parser = subparsers.add_parser("mcp")
    mcp_parser.add_argument("--branch", default=None)

    return parser


def run_cli(args: argparse.Namespace) -> int:
    repo_root = pathlib.Path(args.repo_root).resolve()
    state_root = pathlib.Path(args.state_root).resolve() if args.state_root else None
    kb_root = pathlib.Path(args.kb_root).resolve() if args.kb_root else None
    store = ProofStore(repo_root, state_root=state_root, kb_root=kb_root, repo_key=args.repo_key)
    try:
        command = args.command
        if command == "status":
            print_json(store.status())
            return 0
        if command == "init":
            payload = {
                "repo_id": store.profile["repo_id"],
                "repo_key": store.identity["repo_key"],
                "identity_source": store.identity["identity_source"],
                "repo_root": str(store.repo_root),
                "state_db": str(store.db_path),
                "kb_root": str(store.kb_root),
                "output_dir": str(store.output_rules_dir()),
            }
            if args.json:
                print_json(payload)
            else:
                print(f"Initialized proofd for {payload['repo_id']}")
                if payload["repo_key"]:
                    print(f"Repo key: {payload['repo_key']} ({payload['identity_source']})")
                print(f"KB root: {payload['kb_root']}")
                print(f"State DB: {payload['state_db']}")
                print(f"Output dir: {payload['output_dir']}")
            return 0
        if command == "import-legacy":
            payload = store.import_legacy(
                legacy_rules_dir=(store.repo_root / args.legacy_rules_dir),
                legacy_proofs_dir=(store.repo_root / args.legacy_proofs_dir),
                sync_after=args.sync,
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Imported {payload['rules_imported']} rules and {payload['tags_imported']} tags")
                print(f"Imported {payload['runs_imported']} historical runs")
                if payload["orphan_metadata"]:
                    print("Orphan legacy metadata:")
                    for item in payload["orphan_metadata"]:
                        print(f"  - {item}")
            return 0
        if command == "sync":
            payload = store.sync_rules(branch=args.branch)
            if args.json:
                print_json(payload)
            else:
                print(f"Generated {payload['generated']} rule files into {payload['output_dir']} for branch {payload['branch']}")
            return 0
        if command == "lint":
            payload = store.lint(branch=args.branch)
            if args.json:
                print_json(payload)
            else:
                if payload["warnings"]:
                    print(f"{len(payload['warnings'])} warning(s):")
                    for warning in payload["warnings"]:
                        print(f"  - {warning}")
                else:
                    print("No lint warnings.")
            return 0
        if command == "context":
            print(store.context(args.paths, branch=args.branch, format_name=args.format), end="")
            return 0
        if command == "entry-files":
            payload = store.entry_files(args.tag, branch=args.branch)
            if args.format == "json":
                print_json(payload)
            else:
                print(f"# Files for {payload['tag_id']} ({payload['rule_id']})")
                if payload["files"]:
                    for path in payload["files"]:
                        print(path)
                else:
                    print("_No anchored files._")
                if payload["source_hits"]:
                    print("")
                    print("## Source Tag Hits")
                    for path in payload["source_hits"]:
                        print(path)
            return 0
        if command == "select-matching":
            payload = store.select_matching(args.paths, batch_size=args.batch_size, branch=args.branch)
            if args.json:
                print_json(payload)
            else:
                print(format_select_matching(payload), end="")
            return 0
        if command == "create-rule":
            layer = "canonical" if args.canonical else "workspace"
            payload = store.create_rule(
                title=args.title,
                paths=split_csv(args.paths),
                summary=args.summary,
                rule_id=args.rule_id,
                layer=layer,
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Created rule {payload['rule_id']} with default prefix {payload['default_prefix']}")
            return 0
        if command == "allocate-tag":
            branch = args.branch or current_branch(store.repo_root)
            rule = copy.deepcopy(store.find_rule(args.rule, branch=branch))
            tag_id = store.allocate_tag(rule)
            store.save_rule(rule, layer="workspace", branch=branch)
            payload = {"rule_id": rule["rule_id"], "tag_id": tag_id, "prefix": tag_id.split("-", 1)[0]}
            if args.json:
                print_json(payload)
            else:
                print(tag_id)
            return 0
        if command == "add-entry":
            layer = "canonical" if args.canonical else "workspace"
            payload = store.add_entry(
                rule_id=args.rule,
                statement=args.statement,
                files=split_csv(args.files),
                details=args.detail,
                layer=layer,
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Added [{payload['tag_id']}] to {args.rule}")
            return 0
        if command == "update-entry":
            layer = "canonical" if args.canonical else "workspace"
            _, payload = store.update_entry(
                tag_id=args.tag,
                statement=args.statement,
                files=split_csv(args.files) if args.files is not None else None,
                details=args.detail,
                layer=layer,
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Updated [{payload['tag_id']}]")
            return 0
        if command == "delete-entry":
            layer = "canonical" if args.canonical else "workspace"
            payload = store.delete_entry(
                tag_id=args.tag,
                layer=layer,
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Deleted [{payload['tag_id']}] from {payload['rule_id']}")
            return 0
        if command == "split-rule":
            layer = "canonical" if args.canonical else "workspace"
            original, new_rule = store.split_rule(
                rule_id=args.rule,
                new_title=args.new_title,
                tags=[tag.strip() for tag in args.tags.split(",") if tag.strip()],
                new_rule_id=args.new_rule_id,
                new_paths=split_csv(args.paths) if args.paths else None,
                layer=layer,
            )
            payload = {
                "original_rule_id": original["rule_id"],
                "new_rule_id": new_rule["rule_id"],
                "moved_tags": [entry["tag_id"] for entry in new_rule["entries"]],
                "new_default_prefix": new_rule["default_prefix"],
            }
            if args.json:
                print_json(payload)
            else:
                print(f"Split {payload['original_rule_id']} -> {payload['new_rule_id']} ({', '.join(payload['moved_tags'])})")
            return 0
        if command == "record-verification":
            payload = store.record_verification(
                tag_id=args.tag,
                status=args.status,
                files=split_csv(args.files),
                notes=args.notes,
                agent=args.agent,
                source=args.source,
                update_anchors=args.update_anchors,
                layer="canonical" if args.canonical else "workspace",
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Recorded {payload['status']} for {payload['tag_id']}")
            return 0
        if command == "record-citations":
            payload = store.record_citations(
                tags=[tag.strip() for tag in args.tags.split(",") if tag.strip()],
                command=args.command_name,
                direction=args.direction,
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Recorded {payload['direction']} citations for {', '.join(payload['tags'])}")
            return 0
        if command == "log-run":
            build_time = float(args.build_time) if args.build_time not in (None, "", "null") else None
            payload = store.log_run(
                command=args.cmd,
                summary=args.summary,
                build_time_s=build_time,
                cited_up=[tag.strip() for tag in args.cited_up.split(",") if tag.strip()],
                cited_down=[tag.strip() for tag in args.cited_down.split(",") if tag.strip()],
            )
            if args.json:
                print_json(payload)
            else:
                print(f"Logged run {payload['run_id']} at {payload['ts']}")
            return 0
        if command == "review-brief":
            print(store.review_brief(args.intent, args.approach, args.limitations, args.alternatives), end="")
            return 0
        if command == "promote-overlay":
            payload = store.promote_overlay(branch=args.branch)
            if args.json:
                print_json(payload)
            else:
                print(f"Promoted {payload['promoted']} overlay rule(s) for {payload['branch']}")
            return 0
        if command == "mcp":
            return run_mcp_server(store, branch=args.branch)
        raise RuntimeError(f"Unhandled command: {command}")
    finally:
        store.close()


def mcp_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "proofd_context",
            "description": "Return proofd rule context for one or more repo-relative paths.",
            "inputSchema": {
                "type": "object",
                "properties": {"paths": {"type": "array", "items": {"type": "string"}}, "format": {"type": "string", "enum": ["markdown", "json"]}},
                "required": ["paths"],
            },
        },
        {
            "name": "proofd_entry_files",
            "description": "Return anchored files and source tag hits for one tag.",
            "inputSchema": {
                "type": "object",
                "properties": {"tag": {"type": "string"}},
                "required": ["tag"],
            },
        },
        {
            "name": "proofd_add_entry",
            "description": "Add an entry to an existing rule. The tag is allocated centrally by proofd.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "rule": {"type": "string"},
                    "statement": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "canonical": {"type": "boolean"},
                },
                "required": ["rule", "statement", "files"],
            },
        },
        {
            "name": "proofd_create_rule",
            "description": "Create a new rule with a centrally allocated prefix.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "paths": {"type": "array", "items": {"type": "string"}},
                    "summary": {"type": "string"},
                    "rule_id": {"type": "string"},
                    "canonical": {"type": "boolean"},
                },
                "required": ["title", "paths"],
            },
        },
        {
            "name": "proofd_update_entry",
            "description": "Update an existing entry by tag id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tag": {"type": "string"},
                    "statement": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "canonical": {"type": "boolean"},
                },
                "required": ["tag"],
            },
        },
        {
            "name": "proofd_delete_entry",
            "description": "Delete an existing entry by tag id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tag": {"type": "string"},
                    "canonical": {"type": "boolean"},
                },
                "required": ["tag"],
            },
        },
        {
            "name": "proofd_record_verification",
            "description": "Record a verification result and optionally update anchors.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tag": {"type": "string"},
                    "status": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "notes": {"type": "string"},
                    "update_anchors": {"type": "boolean"},
                },
                "required": ["tag", "status", "files"],
            },
        },
        {"name": "proofd_sync", "description": "Generate `.claude/rules/*.md` from the canonical+overlay store.", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "proofd_lint", "description": "Lint rules, anchors, and auto-load coverage.", "inputSchema": {"type": "object", "properties": {}}},
    ]


def read_mcp_message() -> dict[str, Any] | None:
    headers: dict[str, str] = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("utf-8").partition(":")
        headers[name.strip().lower()] = value.strip()
    content_length = int(headers.get("content-length", "0"))
    body = sys.stdin.buffer.read(content_length)
    if not body:
        return None
    return json.loads(body.decode("utf-8"))


def write_mcp_message(payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def run_mcp_server(store: ProofStore, branch: str | None = None) -> int:
    branch = branch or current_branch(store.repo_root)
    while True:
        request = read_mcp_message()
        if request is None:
            return 0
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})
        try:
            if method == "initialize":
                write_mcp_message(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "proofd", "version": "0.1.0"},
                        },
                    }
                )
                continue
            if method == "notifications/initialized":
                continue
            if method == "tools/list":
                write_mcp_message({"jsonrpc": "2.0", "id": request_id, "result": {"tools": mcp_tools()}})
                continue
            if method == "tools/call":
                name = params.get("name")
                arguments = params.get("arguments", {})
                if name == "proofd_context":
                    result_text = store.context(arguments.get("paths", []), branch=branch, format_name=arguments.get("format", "markdown"))
                elif name == "proofd_entry_files":
                    result_text = stable_json(store.entry_files(arguments["tag"], branch=branch))
                elif name == "proofd_add_entry":
                    result_text = stable_json(
                        store.add_entry(
                            rule_id=arguments["rule"],
                            statement=arguments["statement"],
                            files=arguments.get("files", []),
                            layer="canonical" if arguments.get("canonical") else "workspace",
                            branch=branch,
                        )
                    )
                elif name == "proofd_create_rule":
                    result_text = stable_json(
                        store.create_rule(
                            title=arguments["title"],
                            paths=arguments.get("paths", []),
                            summary=arguments.get("summary", ""),
                            rule_id=arguments.get("rule_id"),
                            layer="canonical" if arguments.get("canonical") else "workspace",
                            branch=branch,
                        )
                    )
                elif name == "proofd_update_entry":
                    _, payload = store.update_entry(
                        tag_id=arguments["tag"],
                        statement=arguments.get("statement"),
                        files=arguments.get("files"),
                        layer="canonical" if arguments.get("canonical") else "workspace",
                        branch=branch,
                    )
                    result_text = stable_json(payload)
                elif name == "proofd_delete_entry":
                    result_text = stable_json(
                        store.delete_entry(
                            tag_id=arguments["tag"],
                            layer="canonical" if arguments.get("canonical") else "workspace",
                            branch=branch,
                        )
                    )
                elif name == "proofd_record_verification":
                    result_text = stable_json(
                        store.record_verification(
                            tag_id=arguments["tag"],
                            status=arguments["status"],
                            files=arguments.get("files", []),
                            notes=arguments.get("notes"),
                            update_anchors=bool(arguments.get("update_anchors")),
                            branch=branch,
                        )
                    )
                elif name == "proofd_sync":
                    result_text = stable_json(store.sync_rules(branch=branch))
                elif name == "proofd_lint":
                    result_text = stable_json(store.lint(branch=branch))
                else:
                    raise RuntimeError(f"Unknown tool: {name}")
                write_mcp_message({"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": result_text}]}})
                continue
            if method == "shutdown":
                write_mcp_message({"jsonrpc": "2.0", "id": request_id, "result": {}})
                continue
            if method == "exit":
                return 0
            raise RuntimeError(f"Unsupported method: {method}")
        except Exception as exc:  # noqa: BLE001
            write_mcp_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(exc)}})


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return run_cli(args)
    except Exception as exc:  # noqa: BLE001
        eprint(f"proofd error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
