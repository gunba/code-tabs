---
paths:
  - "src/components/ConfigManager/PortContentPane.tsx"
---

# src/components/ConfigManager/PortContentPane.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Port Content Pane

- [PC-02 L1] PortContentPane renders as the 'Port content' tab (id: 'port') in ConfigManager. Three port pairs: Skills (.claude/skills <-> .codex/skills or ~/.agents/skills), Memory (CLAUDE.md <-> AGENTS.md), MCP (Claude settings.json mcpServers <-> Codex config.toml [mcp_servers.*]). Each section shows a direction toggle and Apply button. Front-end calls port_skill, port_memory, port_mcp Tauri commands via invoke.
