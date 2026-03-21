# Testing

Test framework, test suites, manual test cases, and coverage notes.

## Framework

- **Unit tests**: Vitest (`npm test`)
- **Type checking**: TypeScript (`npx tsc --noEmit`)
- **Rust checks**: `cargo check` (in `src-tauri/`)

## Test Suites

| Suite | File | Count | What it tests |
|-------|------|-------|---------------|
| `inspectorHooks` | `src/lib/__tests__/inspectorHooks.test.ts` | 65 | Inspector hook install/idempotency, JSON.stringify interception, state derivation, subagent tracking |
| `claude` | `src/lib/__tests__/claude.test.ts` | 23 | Color assignment, `dirToTabName`, `formatTokenCount` |
| `deadSession` | `src/lib/__tests__/deadSession.test.ts` | 18 | Dead session detection heuristics |
| `theme` | `src/lib/theme.test.ts` | 4 | Theme definitions, CSS variable generation |
| `ptyRegistry` | `src/lib/ptyRegistry.test.ts` | 6 | Global PTY writer registry |

## Conventions

- Test files live alongside source in `src/lib/` or `src/lib/__tests__/`
- Naming: `<module>.test.ts`
- Vitest with `describe`/`it`/`expect`
- Tests import directly from source modules
- State machine tests feed sequences of events and assert resulting state
- No mocking of external services — pure functions only
- Test any new pure-logic functions added to `src/lib/`

## Test Harness (E2E)

`src/lib/testHarness.ts` writes app state to `%LOCALAPPDATA%/claude-tabs/test-state.json` every 2s and polls for commands from `test-commands.json`.

### Reading State
```bash
cat "$LOCALAPPDATA/claude-tabs/test-state.json"
```
Contains: session count/states/metadata/colors, CLI version, slash commands, active tab, subagents, console logs.

### Sending Commands
Write JSON to `%LOCALAPPDATA%/claude-tabs/test-commands.json`.
Available: `createSession`, `closeSession`, `reviveSession`, `setActiveTab`, `getSubagents`, `listSessions`, `sendInput`.

### Extending
- New observable state: add fields to `captureState()` in `testHarness.ts`
- New commands: add handlers in the polling loop in `testHarness.ts`

## Manual Test Cases

_Maintained by `/j` (janitor). Add cases here as features are built._
