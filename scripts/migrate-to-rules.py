#!/usr/bin/env python3
"""Migrate DOCS/*.md proved documentation into .claude/rules/ with path-scoped YAML frontmatter.

Reads FEATURES.md, ARCHITECTURE.md, PHILOSOPHY.md. Splits each ## section into a
separate rule file. Splits prove state JSON files correspondingly. Updates config.json.

Run from project root: python scripts/migrate-to-rules.py
"""

import json
import os
import re
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROOFS_DIR = os.path.join(PROJECT_ROOT, ".proofs")
RULES_DIR = os.path.join(PROJECT_ROOT, ".claude", "rules")
CONFIG_PATH = os.path.join(PROOFS_DIR, "config.json")

# Section name -> (rule filename, paths list)
# Paths derived from - Files: references and directory knowledge
SECTION_MAP = {
    # FEATURES.md sections
    "Tab Bar": ("tab-bar.md", ["src/App.tsx", "src/App.css"]),
    "Session Resume": ("session-resume.md", ["src/components/ResumePicker/**", "src/components/Terminal/TerminalPanel.tsx"]),
    "Dead Session Overlay": ("dead-session.md", ["src/components/Terminal/TerminalPanel.tsx", "src/store/sessions.ts"]),
    "Terminal": ("terminal.md", ["src/components/Terminal/**", "src/hooks/useTerminal.ts"]),
    "Session Launcher": ("session-launcher.md", ["src/components/SessionLauncher/**"]),
    "Command Bar": ("command-bar.md", ["src/components/CommandBar/**"]),
    "Hooks Manager": ("hooks-manager.md", ["src/components/ConfigManager/HooksPane.tsx", "src/components/StatusBar/**"]),
    "Config Manager": ("config-manager.md", ["src/components/ConfigManager/**"]),
    "Thinking Panel": None,  # Empty section, skip
    "Debug Panel": ("debug-panel.md", ["src/components/DebugPanel/**", "src/lib/debugLog.ts"]),
    "Window": ("window.md", ["src-tauri/tauri.conf.json"]),
    "Keyboard Shortcuts": ("keyboard-shortcuts.md", ["src/App.tsx", "src/hooks/useTerminal.ts"]),
    "Modal Overlay": ("modal-overlay.md", ["src/components/ModalOverlay/**"]),
    "Git Diff Panel": ("git-diff-panel.md", ["src/components/DiffPanel/**", "src/lib/diffParser.ts"]),
    # ARCHITECTURE.md sections
    "Data Flow": ("data-flow.md", ["src/lib/ptyProcess.ts", "src/lib/ptyRegistry.ts", "src/hooks/useTerminal.ts", "src/lib/paths.ts", "src/lib/diffParser.ts", "src/components/Icons/**"]),
    "State Inspection": ("state-inspection.md", ["src/lib/inspectorHooks.ts", "src/lib/tapStateReducer.ts", "src/lib/tapMetadataAccumulator.ts", "src/hooks/useTapEventProcessor.ts", "src/hooks/useTapPipeline.ts"]),
    "PTY Internals": ("pty-internals.md", ["src-tauri/pty-patch/**", "src/lib/ptyProcess.ts", "src/hooks/useTerminal.ts", "src/components/Terminal/TerminalPanel.tsx"]),
    "Persistence": ("persistence.md", ["src/store/sessions.ts", "src/App.tsx"]),
    "Respawn & Resume": ("respawn-resume.md", ["src/components/Terminal/TerminalPanel.tsx", "src/lib/claude.ts"]),
    "Session Switch": ("session-switch.md", ["src/hooks/useInspectorConnection.ts"]),
    "Inspector": ("inspector.md", ["src/lib/inspectorHooks.ts", "src/lib/inspectorPort.ts", "src/hooks/useInspectorConnection.ts", "src/lib/tapClassifier.ts", "src/lib/tapSubagentTracker.ts", "src/components/SubagentInspector/**"]),
    "Background Buffering": ("background-buffering.md", ["src/components/Terminal/TerminalPanel.tsx", "src/hooks/useTerminal.ts"]),
    "Rust Commands": ("rust-commands.md", ["src-tauri/src/commands.rs", "src-tauri/src/lib.rs"]),
    "Config Implementation": ("config-impl.md", ["src/components/ConfigManager/**", "src/lib/settingsSchema.ts", "src/lib/paths.ts"]),
    # PHILOSOPHY.md section
    "Philosophy": ("philosophy.md", None),  # Global, no paths
}

# Map source file -> sections it contains (for prove state splitting)
SOURCE_FILES = {
    "DOCS/FEATURES.md": "features",
    "DOCS/ARCHITECTURE.md": "architecture",
    "DOCS/PHILOSOPHY.md": "philosophy",
}


def parse_sections(filepath):
    """Parse a doc file into sections. Returns dict of section_name -> {codes_comment, lines, tags}."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.split("\n")
    sections = {}
    current_section = None
    current_lines = []
    codes_comment = ""

    # Extract codes comment from the file header
    codes_match = re.search(r"<!-- Codes: (.+?) -->", content)
    if codes_match:
        codes_comment = codes_match.group(0)

    for line in lines:
        if line.startswith("## "):
            if current_section is not None:
                sections[current_section] = current_lines
            current_section = line.lstrip("# ").rstrip()
            current_lines = []
        elif current_section is not None:
            current_lines.append(line)

    if current_section is not None:
        sections[current_section] = current_lines

    # Extract codes per section from the codes comment
    section_codes = {}
    if codes_match:
        for pair in codes_match.group(1).split(","):
            pair = pair.strip()
            if "=" in pair:
                code, name = pair.split("=", 1)
                section_codes[name.strip()] = code.strip()

    # Extract tags per section
    result = {}
    for section_name, section_lines in sections.items():
        tags = []
        for line in section_lines:
            m = re.match(r"^- \[([A-Z]{2}-\d{2,3})\]", line)
            if m:
                tags.append(m.group(1))

        code = section_codes.get(section_name, "")
        # Build the codes comment for just this section
        section_codes_comment = f"<!-- Codes: {code}={section_name} -->" if code else ""

        result[section_name] = {
            "codes_comment": section_codes_comment,
            "lines": section_lines,
            "tags": tags,
            "code": code,
        }

    return result


def write_rule_file(rule_path, section_name, section_data, paths):
    """Write a single rule file with YAML frontmatter."""
    parts = []

    # YAML frontmatter
    if paths:
        parts.append("---")
        parts.append("paths:")
        for p in paths:
            parts.append(f'  - "{p}"')
        parts.append("---")
        parts.append("")

    # Header
    parts.append(f"# {section_name}")
    parts.append("")

    # Codes comment
    if section_data["codes_comment"]:
        parts.append(section_data["codes_comment"])
        parts.append("")

    # Content (strip leading/trailing blank lines)
    content_lines = section_data["lines"]
    while content_lines and not content_lines[0].strip():
        content_lines = content_lines[1:]
    while content_lines and not content_lines[-1].strip():
        content_lines = content_lines[:-1]

    parts.extend(content_lines)
    parts.append("")  # trailing newline

    os.makedirs(os.path.dirname(rule_path), exist_ok=True)
    with open(rule_path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))

    return len(section_data["tags"])


def split_prove_state(source_basename, sections_with_tags):
    """Split a prove state file into per-rule state files.

    source_basename: e.g. "features"
    sections_with_tags: list of (rule_basename, tag_list)
    """
    source_state_path = os.path.join(PROOFS_DIR, f"prove-{source_basename}.json")
    if not os.path.exists(source_state_path):
        print(f"  No prove state for {source_basename}, creating fresh state files")
        for rule_basename, tags, rule_path in sections_with_tags:
            state = {
                "file": rule_path,
                "all_tags": sorted(tags),
                "unchecked": sorted(tags),
                "citations": {t: {"up": 0, "down": 0} for t in tags},
                "cycle": 1,
                "last_run": None,
            }
            out_path = os.path.join(PROOFS_DIR, f"prove-{rule_basename}.json")
            with open(out_path, "w") as f:
                json.dump(state, f, indent=2)
        return

    with open(source_state_path, "r") as f:
        source_state = json.load(f)

    source_citations = source_state.get("citations", {})
    source_metadata = source_state.get("metadata", {})
    source_unchecked = set(source_state.get("unchecked", []))
    source_cycle = source_state.get("cycle", 1)
    source_last_run = source_state.get("last_run")

    for rule_basename, tags, rule_path in sections_with_tags:
        tag_set = set(tags)
        state = {
            "file": rule_path,
            "all_tags": sorted(tags),
            "unchecked": sorted(tag_set & source_unchecked),
            "citations": {t: source_citations.get(t, {"up": 0, "down": 0}) for t in tags},
            "cycle": source_cycle,
            "last_run": source_last_run,
        }
        # Preserve metadata if it exists
        meta = {t: source_metadata[t] for t in tags if t in source_metadata}
        if meta:
            state["metadata"] = meta

        out_path = os.path.join(PROOFS_DIR, f"prove-{rule_basename}.json")
        with open(out_path, "w") as f:
            json.dump(state, f, indent=2)
        print(f"  prove-{rule_basename}.json: {len(tags)} tags, {len(state['unchecked'])} unchecked")


def main():
    os.chdir(PROJECT_ROOT)

    # Parse all source files
    all_sections = {}
    for source_file in SOURCE_FILES:
        if not os.path.exists(source_file):
            print(f"WARNING: {source_file} not found, skipping")
            continue
        sections = parse_sections(source_file)
        for name, data in sections.items():
            all_sections[name] = (source_file, data)

    # Create rule files
    print("Creating rule files...")
    new_docs = ["CLAUDE.md"]  # CLAUDE.md stays
    total_tags = 0
    # Track sections per source file for prove state splitting
    source_sections = {}  # source_basename -> [(rule_basename, tags, rule_path)]

    for section_name, mapping in SECTION_MAP.items():
        if mapping is None:
            # Empty section, skip
            continue

        rule_filename, paths = mapping

        if section_name not in all_sections:
            print(f"  WARNING: Section '{section_name}' not found in any source file")
            continue

        source_file, section_data = all_sections[section_name]

        if not section_data["tags"]:
            print(f"  Skipping '{section_name}' (no tags)")
            continue

        rule_path = os.path.join(RULES_DIR, rule_filename)
        rel_rule_path = f".claude/rules/{rule_filename}"
        count = write_rule_file(rule_path, section_name, section_data, paths)
        new_docs.append(rel_rule_path)
        total_tags += count

        source_basename = SOURCE_FILES[source_file]
        rule_basename = rule_filename.replace(".md", "")
        source_sections.setdefault(source_basename, []).append(
            (rule_basename, section_data["tags"], rel_rule_path)
        )

        print(f"  {rel_rule_path}: {count} tags")

    print(f"\nTotal: {total_tags} tags across {len(new_docs) - 1} rule files")

    # Split prove state files
    print("\nSplitting prove state...")
    for source_basename, sections_with_tags in source_sections.items():
        print(f"  Splitting prove-{source_basename}.json:")
        split_prove_state(source_basename, sections_with_tags)

    # Update config.json
    print("\nUpdating .proofs/config.json...")
    with open(CONFIG_PATH, "r") as f:
        config = json.load(f)

    config["docs"] = new_docs
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  docs list: {len(new_docs)} entries")

    print("\nMigration complete. Verify with:")
    print(f'  bash "$AGENT_PROOFS_BIN/prove.sh" select-all .claude/rules/tab-bar.md')
    print(f'  bash "$AGENT_PROOFS_BIN/tag-info.sh" stats')


if __name__ == "__main__":
    main()
