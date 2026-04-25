---
paths:
  - "src/components/ConfigManager/ConfigManager.tsx"
---

# src/components/ConfigManager/ConfigManager.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Layout

- [CM-11 L40] Wide modal (84vw, max 1500px, 78vh) with 11 tabs: Settings, Env Vars, Claude, Hooks, Plugins, MCP, Agents, Prompts, Skills & Commands, Port content, Observability (debug only). Store value controls which tab opens. Providers tab replaced by 'Port content' (id: port, PortContentPane) in Codex integration refactor.
- [CM-05 L41] Config tabs route by pane type: Settings and Env Vars use dedicated tabs; Claude and Hooks use 3-column ThreePaneEditor; MCP, Agents, and Skills use 2-column ThreePaneEditor; Plugins, Prompts, Providers, and Recording use dedicated panes.
  - ProvidersPane is keep-alive via a visible prop, while RecordingPane renders only when the Recording tab is active.
- [CM-18 L42] Config tabs use inline SVG icons (gear, document, hook, puzzle, server, bot, skill, lightning, braces, close, circle) instead of emoji -- monochrome, consistent cross-platform.
- [CM-04 L135] Keystrokes blocked via shared ModalOverlay component (onKeyDown stopPropagation); Escape and Ctrl+, pass through to global handler.
- [CM-09 L135] Escape and Ctrl+, close the modal via global handler; clicking the X button closes modal. Backdrop click is disabled (closeOnBackdropClick={false}) — clicking outside the modal does nothing.

## Dual-CLI Config Modal

- [DL-01 L39] ConfigManager shows Claude/Codex switch only when both CLIs are installed (availableCliKinds.length > 1). visibleTabs filtered per CLI: Codex hides envvars, plugins, agents, prompts; port tab is hidden unless both CLIs are installed. ThreePaneEditor and every PaneComponentProps thread a cli prop. SettingsPane uses file_type 'codex-config' (TOML) for Codex vs 'settings' (JSON) for Claude. SettingsTab hides project-local scope for Codex (visibleScopes filters out project-local; effect resets activeScope to project). SkillsEditor reuses the same component with cli prop to call list_codex_skill_files vs list_skills. McpPane switches read_codex_mcp_servers/write_codex_mcp_servers for Codex. HooksPane uses CODEX_HOOK_EVENTS and remaps project-local scope to project on save.
