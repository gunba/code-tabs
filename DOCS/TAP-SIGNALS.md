# Tap Event Framework

How the app intercepts Claude Code's runtime to drive session state, metadata, and subagent tracking without terminal parsing or polling.

## How It Works

Claude Code runs on Bun, which exposes a `BUN_INSPECT` WebSocket (Chrome DevTools Protocol). The app connects to this WebSocket and injects JavaScript that wraps global functions (`JSON.parse`, `JSON.stringify`, `fetch`, `Bun.spawn`, etc.). When these functions are called inside Claude Code, the wrappers push structured entries to the React frontend in real-time via `console.debug` — no polling.

```
Claude Code (Bun process)
    │
    │  JSON.parse/stringify/fetch/spawn call triggers wrapper
    │  wrapper calls: origDebug('\x00TAP' + JSON.stringify(entry))
    │
    ▼  Console.messageAdded WebSocket event (instant)
    │
React Frontend
    │
    ├→ tapClassifier.classify(entry) → TapEvent | null
    │     │
    │     ├→ tapStateReducer     → updateState()
    │     ├→ tapMetadataAccumulator → updateMetadata()
    │     └→ tapSubagentTracker  → addSubagent() / updateSubagent()
    │
    └→ Disk buffer (JSONL recording, if enabled)
```

## File Map

| File | Lines | Purpose |
|------|-------|---------|
| `src/lib/inspectorHooks.ts` | INSTALL_TAPS expression | JS injected into Bun process. Wraps 12 function categories. Push-based via `console.debug` with `\x00TAP` prefix. `parse` and `stringify` always on; others opt-in. Also contains fetch bypass and HTTPS timeout patches (moved from former INSTALL_HOOK). |
| `src/types/tapEvents.ts` | 264 | Discriminated union of ~28 typed event interfaces. Every event has `ts: number` and `kind: string`. |
| `src/lib/tapClassifier.ts` | 424 | Stateless pure function: `TapEntry → TapEvent \| null`. Pattern-matches on `entry.cat` + parsed `entry.snap`. Returns null for noise and high-frequency deltas. |
| `src/lib/tapEventBus.ts` | 53 | Module-level singleton pub/sub. Per-session subscriber registration. `dispatch()` and `dispatchBatch()`. |
| `src/lib/tapStateReducer.ts` | 111 | Pure function: `(SessionState, TapEvent) → SessionState`. Replaces the old POLL_STATE polling. Batch reducer with `waitingPermission` priority. |
| `src/lib/tapMetadataAccumulator.ts` | 220 | Stateful class (one per session). Processes events, returns `Partial<SessionMetadata>` diffs via fingerprint comparison. Tracks cost, tokens, model, context%, duration, API region, subscription tier, hook status, TTFT. |
| `src/lib/tapSubagentTracker.ts` | 196 | Stateful class (one per session). Tracks subagent spawn → run → completion/kill lifecycle. Returns `SubagentAction[]` for the store. |
| `src/hooks/useInspectorConnection.ts` | 136 | WebSocket lifecycle only. Connects to BUN_INSPECT, sends `Console.enable`, forwards all messages to external handler. Retry with backoff. No state derivation. |
| `src/hooks/useTapPipeline.ts` | 205 | Receives `Console.messageAdded` events, parses `\x00TAP` prefix, classifies, dispatches to bus, buffers for disk recording. Always installs taps on connect. Core categories (parse/stringify) always on; optional categories toggled by user. |
| `src/hooks/useTapEventProcessor.ts` | 149 | Subscribes to tapEventBus. Runs reducer, accumulator, and subagent tracker. Calls store actions. Handles completion signals, session registration, custom titles, slash command history, worktree cwd detection. |

## Push Delivery (No Polling)

The old system polled every 250ms (POLL_STATE) and 500ms (POLL_TAPS). The new system uses push delivery:

1. **In the Bun process:** Each hooked function calls `push(cat, data)` which calls `origDebug.call(console, '\x00TAP' + origStringify(data))`. The original `console.debug` is saved before any wrapping to avoid recursion.

2. **Over the WebSocket:** BUN_INSPECT delivers `Console.messageAdded` events to the frontend the instant `console.debug` is called. No polling interval.

3. **In the frontend:** `useTapPipeline` detects the `\x00TAP` prefix in `Console.messageAdded` messages, strips it, parses the JSON entry, classifies it, and dispatches immediately.

## Event Types

### From `cat=parse` (Anthropic SSE stream via JSON.parse)

| Event | Trigger | Key Fields |
|-------|---------|-----------|
| `TurnStart` | `message_start` SSE | `model`, `inputTokens`, `outputTokens`, `cacheRead`, `cacheCreation` |
| `ThinkingStart` | `content_block_start` type=thinking | `index` |
| `TextStart` | `content_block_start` type=text | `index` |
| `ToolCallStart` | `content_block_start` type=tool_use | `toolName`, `toolId`, `index` |
| `BlockStop` | `content_block_stop` | `index` |
| `TurnEnd` | `message_delta` with stop_reason | `stopReason` ("end_turn"\|"tool_use"), `outputTokens` |
| `MessageStop` | `message_stop` | (none) |

`content_block_delta` events (token-by-token streaming) are NOT classified — written to disk only.

### From `cat=stringify` (outgoing data via JSON.stringify)

| Event | Shape Detection | Key Fields |
|-------|----------------|-----------|
| `UserInput` | has `display` + `timestamp` + `sessionId` | `display` (exact user text), `sessionId` |
| `SlashCommand` | `UserInput` where display starts with "/" | `command` (e.g. "/compact"), `display` |
| `ApiTelemetry` | has `costUSD` + `durationMs` | `model`, `costUSD`, `durationMs`, `ttftMs`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `queryChainId`, `queryDepth`, `stopReason` |
| `ApiRequestInfo` | has `model` + `messages` array (no `costUSD`) | `model`, `systemLength`, `toolCount`, `messageCount` |
| `ConversationMessage` | `type` is "user"\|"assistant" | `messageType`, `isSidechain`, `agentId`, `uuid`, `parentUuid`, `promptId`, `stopReason`, `toolNames`, `toolAction`, `textSnippet`, `cwd` |
| `SubagentSpawn` | has `description` + `prompt` (no `type`) | `description`, `prompt` |
| `SubagentNotification` | `type=queue-operation` with `<status>` XML | `status` ("completed"\|"killed"), `summary` |
| `PermissionPromptShown` | `setMode` array OR `tengu_tool_use_show_permission_request` shape | `toolName` |
| `PermissionApproved` | `tengu_accept_submitted` shape | `toolName` |
| `PermissionRejected` | user message with "doesn't want to proceed" | (none) |
| `UserInterruption` | user message with "[Request interrupted by user" | `forToolUse` (boolean) |
| `ModeChange` | has `rh` + `to` | `to` ("default"\|"acceptEdits"\|"plan"\|"bypassPermissions") |
| `SessionRegistration` | has `pid` + `sessionId` + `startedAt` | `pid`, `sessionId`, `cwd`, `name` |
| `AccountInfo` | has `accountUuid` + `subscriptionType` | `subscriptionType`, `rateLimitTier`, `billingType`, `displayName` |
| `CustomTitle` | `type=custom-title` | `title`, `sessionId` |
| `ProcessHealth` | has `rss` + `heapUsed` + `uptime` | `rss`, `heapUsed`, `heapTotal`, `uptime`, `cpuPercent` |
| `RateLimit` | has `status` (string) + `hoursTillReset` | `status`, `hoursTillReset` |
| `HookProgress` | `type=progress` with `data.type=hook_progress` | `hookEvent`, `hookName`, `command`, `statusMessage` |
| `ToolInput` | Known tool input shapes (command, file_path, pattern, etc.) | `toolName`, `input` (raw object) |
| `SessionResume` | assistant message with `model="<synthetic>"` | (none) |

### From `cat=fetch`

| Event | Key Fields |
|-------|-----------|
| `ApiFetch` | `url`, `method`, `status`, `bodyLen`, `durationMs`, `requestId`, `cfRay`, `rateLimitRemaining`, `rateLimitReset` |

The `cfRay` header encodes the Cloudflare edge location as a suffix (e.g., `abc123-SYD` → region `SYD`).

### From `cat=bun.spawn` / `cat=spawn`

| Event | Key Fields |
|-------|-----------|
| `SubprocessSpawn` | `cmd`, `cwd`, `pid` |

## State Machine

The state reducer (`tapStateReducer.ts`) is a pure function that maps events to session states:

| Event | → State |
|-------|---------|
| `TurnStart` | `thinking` |
| `ThinkingStart` | `thinking` |
| `TextStart` | `thinking` |
| `ToolCallStart` | `thinking` (still streaming); `actionNeeded` if ExitPlanMode |
| `TurnEnd` stop=`tool_use` | `toolUse` |
| `TurnEnd` stop=`end_turn` | `idle` |
| `PermissionPromptShown` | `waitingPermission` |
| `PermissionApproved` | `toolUse` |
| `PermissionRejected` | `idle` |
| `UserInterruption` | `idle` |
| `UserInput` / `SlashCommand` | `thinking` |

The batch reducer folds events with a priority rule: `waitingPermission` always wins if triggered anywhere in the batch.

## Metadata Accumulation

The accumulator (`tapMetadataAccumulator.ts`) tracks all `SessionMetadata` fields:

| Field | Source Event | How |
|-------|-------------|-----|
| `costUsd` | `ApiTelemetry` | Running sum of `costUSD` |
| `contextPercent` | `TurnStart` | `min(99, round(cacheRead / 200000 * 100))` |
| `durationSecs` | `ApiTelemetry` | Running sum of `durationMs` / 1000 |
| `inputTokens` | `ApiTelemetry` | Sum of `inputTokens + cachedInputTokens` |
| `outputTokens` | `ApiTelemetry` | Running sum |
| `runtimeModel` | `TurnStart`, `ApiTelemetry` | Latest model string |
| `currentToolName` | `ToolCallStart` | Current tool; cleared on `TurnEnd`/`UserInput` |
| `currentAction` | `ToolInput`, `ConversationMessage` | Formatted "Tool: path/command" |
| `nodeSummary` | `UserInput`, `SlashCommand`, `ConversationMessage` | First user message text |
| `assistantMessageCount` | `ConversationMessage` (assistant) | Increment per non-sidechain assistant message |
| `choiceHint` | `ToolCallStart` (AskUserQuestion) | True when selector is active |
| `apiRegion` | `ApiFetch` | Airport code from `cfRay` suffix |
| `lastRequestId` | `ApiFetch` | Latest `request-id` header |
| `subscriptionType` | `AccountInfo` | "max", "pro", etc. |
| `hookStatus` | `HookProgress`, `RateLimit` | Transient status; cleared on next turn/input |
| `lastTurnCostUsd` | `ApiTelemetry` | Per-turn cost |
| `lastTurnTtftMs` | `ApiTelemetry` | Per-turn time-to-first-token |
| `systemPromptLength` | `ApiRequestInfo` | System prompt char count |
| `toolCount` | `ApiRequestInfo` | Number of registered tools |
| `conversationLength` | `ApiRequestInfo` | Messages in API request |

All fields use fingerprint-based diffing — `updateMetadata()` is only called when values change.

## Subagent Tracking

The subagent tracker (`tapSubagentTracker.ts`) manages the full lifecycle:

1. **Spawn detection:** `ToolCallStart` name=`Agent` → pending. `SubagentSpawn` → queue description.
2. **Agent creation:** First `ConversationMessage` with `isSidechain:true` and unknown `agentId` → `addSubagent()` with queued description.
3. **State updates:** Subsequent sidechain messages update state (thinking/toolUse/idle based on `stopReason`), accumulate messages (capped at 200).
4. **Token attribution:** `ApiTelemetry` with `queryDepth > 0` → attributed to `lastActiveAgent` (set by most recent sidechain message).
5. **Completion:** `SubagentNotification` status=`completed` → mark first non-idle agent as idle.
6. **Kill:** `SubagentNotification` status=`killed` → mark first non-idle agent as dead.

## Hooked Categories

| Category | Flag | Always On | What It Captures |
|----------|------|-----------|-----------------|
| `parse` | `flags.parse` | Yes | Every `JSON.parse` call — SSE events, config, JSONL |
| `stringify` | `flags.stringify` | Yes | Every `JSON.stringify` call — API requests, telemetry, conversation, user input |
| `fetch` | `flags.fetch` | No | HTTP requests — URL, method, status, body size, duration, response headers |
| `bun.spawn` | `flags.bun` | No | Bun.spawn/spawnSync — command, cwd, pid, exit code |
| `spawn` | `flags.spawn` | No | child_process.spawn/exec — command, cwd, pid |
| `console` | `flags.console` | No | console.log/warn/error — messages |
| `fs` | `flags.fs` | No | fs.readFileSync/writeFileSync/existsSync/statSync/readdirSync |
| `stdout` | `flags.stdout` | No | process.stdout.write — raw terminal output |
| `stderr` | `flags.stderr` | No | process.stderr.write — error output |
| `timer` | `flags.timer` | No | setTimeout/clearTimeout/setInterval/clearInterval (≥100ms) |
| `exit` | `flags.exit` | No | process.exit — exit code |
| `require` | `flags.require` | No | Module.require — module IDs |

`parse` and `stringify` are always on because they drive state detection. The other categories are opt-in for debug recording — toggled via the tab right-click menu ("Start All Taps" / individual toggles).

## StatusBar Integration

The StatusBar displays metadata from tap events:

- **Model + Subscription + Region:** `Opus 4 · Max · SYD` — from `TurnStart.model`, `AccountInfo.subscriptionType`, `ApiFetch.cfRay`
- **Context %:** Tooltip shows breakdown — `"Context: 45% (91K tokens) · 93 tools · 12 messages · 8K system prompt"` — from `TurnStart.cacheRead` and `ApiRequestInfo`
- **Cost tooltip:** `"Total: $0.42 · Last turn: $0.02 · TTFT: 1.9s · Request: req_abc..."` — from `ApiTelemetry` and `ApiFetch.requestId`
- **Hook status:** Transient `"Type-checking..."` when PostToolUse hooks run — from `HookProgress`
- **Duration:** API time accumulated from `ApiTelemetry.durationMs`

## Recording vs State Detection

Recording (writing to JSONL on disk) and state detection (driving the UI) are separate concerns sharing the same pipeline:

- **State detection:** Always active. `parse` and `stringify` flags are hardcoded to `true`. Every entry from these categories is classified and dispatched through the event bus.
- **Recording:** Opt-in. When the user enables tap categories via the UI, entries are buffered in memory and flushed to `{data_dir}/taps/{sessionId}.jsonl` every 2s or at 50 entries. Core categories (parse/stringify) are always recorded when any recording is active. Optional categories only record if individually enabled.

## Testing

Test files in `src/lib/__tests__/`:

| Test | Tests |
|------|-------|
| `tapClassifier.test.ts` | 31 — Classification of all SSE types, stringify shapes, fetch, spawn, noise filtering |
| `tapStateReducer.test.ts` | 23 — State transitions, batch reduction, completion detection, priority rules |
| `tapMetadataAccumulator.test.ts` | 7 — Cost/token accumulation, fingerprint diffing, model tracking |
| `tapEventBus.test.ts` | 7 — Subscribe/unsubscribe, dispatch, batch, clear |
| `inspectorTaps.test.ts` | 20 — INSTALL_TAPS hook installation, category toggling, push delivery |

Tests that install INSTALL_TAPS must mute the always-on flags immediately after installation (`flags.parse = false; flags.stringify = false`) to prevent vitest's own JSON operations from flooding the tap buffer.
