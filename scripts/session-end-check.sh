#!/bin/bash
# Hook script: runs when Claude stops. Checks for issues and returns
# a JSON systemMessage reminding the agent to fix them.
#
# Used by the Stop hook in .claude/settings.local.json

cd "$(dirname "$0")/.." || exit 0

issues=()

# 1. TypeScript errors
if ! npx tsc --noEmit 2>/dev/null; then
  issues+=("TypeScript has errors — run npx tsc --noEmit and fix them")
fi

# 2. Test failures
if ! npm test 2>/dev/null | grep -q "0 failed"; then
  test_output=$(npm test 2>&1 | tail -5)
  if echo "$test_output" | grep -q "failed"; then
    issues+=("Tests are failing — run npm test and fix them")
  fi
fi

# 3. Rust compilation
if ! (cd src-tauri && cargo check 2>/dev/null); then
  issues+=("Rust has compilation errors — run cargo check in src-tauri/")
fi

# 4. Unused exports (quick grep for common dead code patterns)
unused=$(grep -rn "export function\|export const\|export class" src/lib/ src/hooks/ 2>/dev/null | \
  while IFS=: read -r file line content; do
    name=$(echo "$content" | sed 's/.*export \(function\|const\|class\) \([a-zA-Z_]*\).*/\2/')
    if [ -n "$name" ] && [ "$name" != "$content" ]; then
      count=$(grep -rn "$name" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "^$file:" | wc -l)
      if [ "$count" -eq 0 ]; then
        echo "$file: $name"
      fi
    fi
  done)
if [ -n "$unused" ]; then
  issues+=("Possible dead exports found: $unused")
fi

# Build the response
if [ ${#issues[@]} -eq 0 ]; then
  # All clear — no message needed
  echo '{}'
else
  # Join issues into a message
  msg="Before finishing, please address these issues:\\n"
  for issue in "${issues[@]}"; do
    msg+="- $issue\\n"
  done
  msg+="\\nAlso verify docs/STATUS.md is up to date."
  echo "{\"systemMessage\": \"$msg\"}"
fi
