---
paths:
  - "src/lib/tapStateReducer.ts"
---

# src/lib/tapStateReducer.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## State Tap Reducer

- [SI-03 L5] reduceTapEvent() / reduceTapBatch() -- pure state reducer: (SessionState, TapEvent) -> SessionState. Event-driven, no polling, no terminal buffer fallback.
- [SI-08 L6] State is NEVER inferred from timers or arbitrary delays -- only from real signals
- [SI-19 L7] Terminal buffer prompt fallback removed: tap event pipeline is push-based; idle detection via TurnEnd(end_turn), ConversationMessage(assistant, end_turn), and TurnDuration events. TurnDuration fires as the final stringify event of every completed turn and provides an independent recovery path to idle when TurnEnd/ConversationMessage don't reach the reducer.
- [SI-13 L13] tapStateReducer event priority: actionNeeded is a sticky state preserved by an early-return guard at the top of reduceTapEvent -- only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ConversationMessage(user, non-sidechain), IdlePrompt, and ToolResult(AskUserQuestion/ExitPlanMode) or TurnStart can clear it. ExitPlanMode tool call -> actionNeeded; PermissionPromptShown -> waitingPermission (always wins via reduceTapBatch); UserInterruption -> interrupted; TurnEnd(end_turn) -> idle; TurnEnd(tool_use) -> toolUse; IdlePrompt -> idle (authoritative).
- [SI-04 L38] Permission detection via `PermissionPromptShown` tap event (not PTY regex). tapStateReducer transitions to waitingPermission directly from tap events.
- [SI-23 L57] Plan detection relies solely on `ToolCallStart(ExitPlanMode)` -> `actionNeeded`. ToolCallStart fires during the SSE stream, structurally before any UserInput can arrive. actionNeeded is sticky: only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ToolResult(AskUserQuestion/ExitPlanMode), or TurnStart can clear it.
- [IN-13 L83] SessionState 'interrupted' added: UserInterruption transitions to interrupted (not idle). Visually distinct (red dot, no pulse) but functionally equivalent to idle via isSessionIdle() helper. Auto-clears to thinking on next UserInput/ConversationMessage. clearIdleSubagents also clears interrupted.
