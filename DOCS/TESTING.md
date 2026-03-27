# Testing

Test framework, test suites, manual test cases, and coverage notes.

## Framework

- **Unit tests**: Vitest (`npm test`)
- **Type checking**: TypeScript (`npx tsc --noEmit`)
- **Rust checks**: `cargo check` (in `src-tauri/`)

## Test Suites

| Suite | File | Count | What it tests |
|-------|------|-------|---------------|
| `inspectorHooks` | `src/lib/__tests__/inspectorHooks.test.ts` | 150 | Inspector hook install/idempotency, JSON.stringify interception, state derivation, subagent tracking, slash command detection, stdin handler, fetch/https wrappers |
| `inspectorTaps` | `src/lib/__tests__/inspectorTaps.test.ts` | 20 | INSTALL_TAPS hook: JSON.parse, console, stdout, timer wrappers; tapToggle expressions |
| `paths` | `src/lib/__tests__/paths.test.ts` | 78 | Path helpers, worktree detection, tab grouping |
| `claude` | `src/lib/__tests__/claude.test.ts` | 73 | Color assignment, `dirToTabName`, `formatTokenCount`, model resolution |
| `settingsSchema` | `src/lib/__tests__/settingsSchema.test.ts` | 70 | CLI settings.json schema discovery and parsing |
| `resumePicker` | `src/lib/__tests__/resumePicker.test.ts` | 46 | Resume session picker logic |
| `highlightJson` | `src/lib/__tests__/highlightJson.test.ts` | 27 | JSON syntax highlighting |
| `sessions` | `src/store/__tests__/sessions.test.ts` | 25 | Zustand session store actions |
| `deadSession` | `src/lib/__tests__/deadSession.test.ts` | 18 | Dead session detection heuristics |
| `inspectorPort` | `src/lib/__tests__/inspectorPort.test.ts` | 17 | Inspector port allocation and registry |
| `normalizePlugins` | `src/lib/__tests__/normalizePlugins.test.ts` | 17 | Plugin normalization |
| `deferredResize` | `src/lib/__tests__/deferredResize.test.ts` | 15 | Deferred terminal resize logic |
| `ptyCleanup` | `src/lib/__tests__/ptyCleanup.test.ts` | 9 | PTY cleanup on session close |
| `ptyRegistry` | `src/lib/__tests__/ptyRegistry.test.ts` | 9 | Global PTY writer + kill registry |
| `theme` | `src/lib/__tests__/theme.test.ts` | 4 | Theme definitions, CSS variable generation |
| `tapClassifier` | `src/lib/__tests__/tapClassifier.test.ts` | 35 | Tap entry classification (SSE parse, stringify, fetch, spawn) |
| `tapEventBus` | `src/lib/__tests__/tapEventBus.test.ts` | 7 | Per-session tap event pub/sub |
| `tapMetadataAccumulator` | `src/lib/__tests__/tapMetadataAccumulator.test.ts` | 7 | Tap metadata accumulation (cost, model, tokens) |
| `tapStateReducer` | `src/lib/__tests__/tapStateReducer.test.ts` | 19 | Tap event → session state reduction |
| `ptySpawn` | `src/lib/__tests__/ptySpawn.test.ts` | 4 | PTY spawn with parallel exit waiter |

## Conventions

- Test files live alongside source in `src/lib/` or `src/lib/__tests__/`
- Naming: `<module>.test.ts`
- Vitest with `describe`/`it`/`expect`
- Tests import directly from source modules
- State machine tests feed sequences of events and assert resulting state
- No mocking of external services — pure functions only
- Test any new pure-logic functions added to `src/lib/`

## Global-Wrapping Tests (OOM Prevention)

INSTALL_HOOK and INSTALL_TAPS both monkey-patch `JSON.stringify`, `JSON.parse`, `setTimeout`, `console.*`, etc. These tests require special care:

1. **Never share a vitest worker between INSTALL_HOOK and INSTALL_TAPS tests.** Both wrap `JSON.stringify`. When wrappers stack (wrapper captures wrapped version as "original"), vitest's internal JSON operations create exponential data growth → OOM. This is why `inspectorHooks.test.ts` and `inspectorTaps.test.ts` are separate files.

2. **Snapshot pristine globals at module load, restore in afterEach.** Before any wrapper installs, capture the real `JSON.stringify`, `setTimeout`, etc. Restore them in every `afterEach` / `cleanupX` function so wrappers never stack across tests.

3. **Use pristine functions inside test helpers.** `collectTapEntries()` must use `_pristine.jsonParse()` instead of `JSON.parse()` — otherwise calling `JSON.parse` inside a loop over spy results triggers the parse wrapper, which adds more spy entries, creating an infinite loop.

4. **Mute always-on flags immediately after install.** INSTALL_TAPS defaults `parse: true, stringify: true`. Vitest's own JSON operations flood the `console.debug` spy with TAP entries. Call `muteTapDefaults()` right after `_installTapsFn()`, then re-enable only the flag each test needs.

5. **Don't restore timers in INSTALL_HOOK cleanup.** INSTALL_HOOK doesn't wrap timers, and `restoreGlobals()` in `cleanupGlobalHook` would clobber `vi.useFakeTimers()`.

## Manual Test Cases

_Maintained by `/j` (janitor). Add cases here as features are built._
