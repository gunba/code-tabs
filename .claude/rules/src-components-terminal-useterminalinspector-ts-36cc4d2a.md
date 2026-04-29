---
paths:
  - "src/components/Terminal/useTerminalInspector.ts"
---

# src/components/Terminal/useTerminalInspector.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-07 L45] Config caching: session configs cached in sessionConfigs map (localStorage) when inspector connects (model, permissionMode, dangerouslySkipPermissions, effort, agent, maxBudget, verbose, debug, projectDir, extraFlags, systemPrompt, appendSystemPrompt, allowedTools, disallowedTools, additionalDirs, mcpConfig); used as fallback when resuming sessions not in the dead tab map

## Session Resume

- [SR-01 L33] Loading spinner hides on the first session-ready signal, which is CLI-specific: Claude listens for inspector.connected (~1s after spawn); Codex (no inspector) listens for the first session.state transition off 'starting'. Effect deps: [loading, inspector.connected, session.config.cli, session.state].
