---
paths:
  - "src/components/ConfigManager/ConfigManager.tsx"
---

# src/components/ConfigManager/ConfigManager.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Layout

- [CM-11 L39] Wide modal (84vw, max 1500px, 78vh) with 11 tabs: Settings, Env Vars, Claude, Hooks, Plugins, MCP, Agents, Prompts, Skills, Providers, Recording. Store value controls which tab opens.
- [CM-05 L40] Config tabs route by pane type: Settings and Env Vars use dedicated tabs; Claude and Hooks use 3-column ThreePaneEditor; MCP, Agents, and Skills use 2-column ThreePaneEditor; Plugins, Prompts, Providers, and Recording use dedicated panes.
  - ProvidersPane is keep-alive via a visible prop, while RecordingPane renders only when the Recording tab is active.
- [CM-18 L41] Config tabs use inline SVG icons (gear, document, hook, puzzle, server, bot, skill, lightning, braces, close, circle) instead of emoji -- monochrome, consistent cross-platform.
- [CM-20 L42] Tab label reads "Claude" instead of "CLAUDE.md" for the markdown editor tab.
- [CM-04 L107] Keystrokes blocked via shared ModalOverlay component (onKeyDown stopPropagation); Escape and Ctrl+, pass through to global handler.
- [CM-09 L107] Escape and Ctrl+, close the modal via global handler; clicking the X button closes modal. Backdrop click is disabled (closeOnBackdropClick={false}) — clicking outside the modal does nothing.
