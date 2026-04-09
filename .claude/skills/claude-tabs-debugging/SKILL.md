---
name: claude-tabs-debugging
description: Investigate Claude Tabs debug captures. Use only when the user is explicitly working with debug logs, session IDs, TAP output, proxy traffic, observability files, or debug markers and wants log-based analysis or correlation.
---

# Claude Tabs Debugging

Treat Claude Code as a moving target. Verify behavior from local Claude Code source before assuming how it works.

## Source of truth

- Check `C:\Users\jorda\PycharmProjects\claude_code\src` first for Claude Code behavior.
- If behavior is still unclear, ask the user to reproduce in the debug build and inspect the logs instead of guessing.

## Log order

Debug observability is debug-build only. If a bug needs logs, reproduce it in the debug build.

Primary files:

- `%LOCALAPPDATA%\claude-tabs\observability\app.jsonl`
- `%LOCALAPPDATA%\claude-tabs\sessions\<sessionId>\observability.jsonl`
- `%LOCALAPPDATA%\claude-tabs\sessions\<sessionId>\taps.jsonl`
- `%LOCALAPPDATA%\claude-tabs\sessions\<sessionId>\traffic.jsonl`

Start with `observability.jsonl`. Use it as the correlated timeline. Read `WARN`, `ERR`, and `event = "perf.span"` first, then narrow by `sessionId`, `module`, `event`, and `data`.

Use:

```powershell
lnav "$env:LOCALAPPDATA\claude-tabs\observability\app.jsonl" "$env:LOCALAPPDATA\claude-tabs\sessions\<sessionId>\observability.jsonl"
```

to align app-wide and session-specific timestamps.

## File roles

- Use `taps.jsonl` to answer "what did Claude Code emit?"
- Use `traffic.jsonl` to answer "what hit the proxy/network?"
- When terminal behavior looks wrong, inspect terminal, PTY, and session spawn events before assuming a Claude Code regression.

## Debug markers

The debug build exposes marker buttons in the Debug Panel. They emit `event = "debug.marker"` with `data.markerId`, `data.markerIndex`, and `data.targetSessionId`. Markers may land in either the app log or the target session log, so check both before concluding they are missing.

## Working style

- Do not ask for smaller logs by default. Filter the noisy logs instead of discarding them.
- Prefer concrete dates, session IDs, and exact event names in debugging writeups.
