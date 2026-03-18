#!/bin/bash
# Stop hook: after code changes, prompt user to select agents to run.

INPUT=$(cat)
PROJECT="${CLAUDE_PROJECT_DIR:-.}"

# Prevent infinite loop — if this stop was already triggered by the hook, bail
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

# Check for uncommitted code changes vs HEAD
CODE_CHANGES=$(git -C "$PROJECT" diff --name-only HEAD 2>/dev/null | grep -cE '\.(tsx?|rs|css)$' || echo 0)

if [ "${CODE_CHANGES}" -eq 0 ]; then
  exit 0
fi

cat <<'EOF'
{"decision":"block","reason":"Code changes detected. Ask the user which agents to run. Present as a numbered checklist — the user picks by number (e.g. '1,3'), 'all', or 'none' to skip. Run selected agents sequentially in the listed order:\n\n  1. test-runner — Run tests and check for failures\n  2. code-reviewer — Review for bugs, anti-patterns, CLAUDE.md violations\n  3. code-simplifier — Clean up dead code, simplify logic\n  4. qa — Build app and verify via test harness\n  5. builder — Build a release\n\nKeep the prompt concise. If user says 'none' or declines, stop immediately."}
EOF
exit 0
