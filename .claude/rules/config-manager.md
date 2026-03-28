---
paths:
  - "src/components/ConfigManager/**"
---

# Config Manager

<!-- Codes: CM=Config Manager -->

- [CM-01] Config modal header uses CSS grid (1fr auto 1fr) instead of flexbox space-between, so tab row stays centered regardless of left (title) or right (project selector + close) content width.
  - Files: src/components/ConfigManager/ConfigManager.css:16, src/components/ConfigManager/ConfigManager.tsx:66
- [CM-02] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.
  - Files: src/lib/paths.ts:89
- [CM-03] Project directory selector: when multiple working dirs exist across sessions, the config modal header shows a dropdown to switch between project-level scopes. settingsSchema.ts builds the schema; fetch_settings_schema provides the Rust backend.
  - Files: src/lib/settingsSchema.ts:223, src-tauri/src/commands.rs:890
- [CM-04] Keystrokes blocked via shared ModalOverlay component (`onKeyDown` stopPropagation); Escape and `Ctrl+,` pass through to global handler
- [CM-05] Four content tabs (Claude/Hooks/Agents/Skills) use ThreePaneEditor: 3-column grid showing User/Project/Local scopes side by side with color-coded borders and tinted headers. Plugins tab uses dedicated PluginsTab component (single-pane, CLI-driven). Prompts tab uses dedicated PromptsTab component (single-pane). Settings tab uses dedicated SettingsTab component with unified reference panel.
  - Files: src/components/ConfigManager/ConfigManager.tsx:102, src/components/ConfigManager/SettingsTab.tsx:1, src/components/ConfigManager/PluginsPane.tsx:75
- [CM-06] Per-scope raw JSON settings editor (SettingsPane) and CLAUDE.md editor (MarkdownPane) with own dirty tracking and Save per pane. Tab key inserts 2 spaces in markdown.
- [CM-07] Agent editor: scoped via ThreePaneEditor (user/project/local) with agent pills at top, editor below. Auto-selects first agent on load (or enters new-agent mode if none). Textarea always visible -- no empty state. Dashed '+ new agent' pill replaces old + New button/inline form. Duplicate name validation on create. Ctrl+S dispatches to create or save based on mode. User scope scans ~/.claude/agents/, project scans {wd}/.claude/agents/, local scans {wd}/.claude/local/agents/.
  - Files: src/components/ConfigManager/AgentEditor.tsx:6, src/components/ConfigManager/ConfigManager.css:701
- [CM-08] Save via Rust `read_config_file`/`write_config_file` commands (JSON validated before write, parent dirs auto-created)
- [CM-09] Escape closes modal; clicking overlay closes modal
- [CM-10] Settings schema cached in localStorage (`binarySettingsSchema`) to avoid re-scanning on every startup
- [CM-11] Wide modal (96vw, max 1900px, 88vh) with 7 tabs: Settings, Claude, Hooks, Plugins, Agents, Prompts, Skills. All tabs render at full width. Store value controls which tab opens.
  - Files: src/components/ConfigManager/ConfigManager.tsx:64, src/components/ConfigManager/ConfigManager.css:1
- [CM-12] ThreePaneEditor: Claude/Hooks/Agents/Skills tabs use 3-column grid showing User/Project/Local scopes side by side. Color coded: User=clay, Project=blue, Local=purple (left border + tinted header). Plugins and Prompts tabs excluded (use single-pane components).
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:1, src/components/ConfigManager/ConfigManager.css:129
- [CM-13] SettingsPane: JSON textarea with syntax highlighting overlay (pre behind transparent textarea). Both layers use position: absolute; inset: 0 inside sh-container for proper fill. Keys=clay, strings=blue, numbers/bools=purple. Scroll synced between layers. Ctrl+S to save.
  - Files: src/components/ConfigManager/SettingsPane.tsx:15, src/components/ConfigManager/ConfigManager.css:1050
- [CM-14] MarkdownPane: per-scope CLAUDE.md textarea. Tab key inserts 2 spaces. Scope-to-fileType mapping: user=claudemd-user, project=claudemd-root, project-local=claudemd-dotclaude.
  - Files: src/components/ConfigManager/MarkdownPane.tsx:1
- [CM-15] HooksPane: per-scope CRUD absorbed from standalone HooksManager. Hook cards, inline Add/Edit form. Scope is a prop, not a dropdown. Calls bumpHookChange() after save.
  - Files: src/components/ConfigManager/HooksPane.tsx:1
- [CM-16] PluginsTab: CLI-driven plugin management via 5 IPC commands (plugin_list/install/uninstall/enable/disable). Keep-alive mounted (always rendered, hidden via display:none when tab not selected, re-fetches on visibility). Unified 3-column tile grid for both installed and marketplace plugins. Tiles show name, description, version, scope badge, color-coded install count (orange 10K+, purple 1K+, blue <1K). Sorting by popularity or name. normalizePlugins export retained for test compatibility. MCP servers shown as cards with manual save.
  - Files: src/components/ConfigManager/PluginsPane.tsx, src/components/ConfigManager/ConfigManager.css, src/components/ConfigManager/ConfigManager.tsx
- [CM-17] StatusBar hooks button opens config manager directly to Hooks tab. Store: showConfigManager is string|false (tab name or closed), replacing old boolean + separate showHooksManager.
  - Files: src/components/StatusBar/StatusBar.tsx:140, src/store/settings.ts:49
- [CM-18] Config tabs use inline SVG icons (gear, document, hook, puzzle, bot) instead of emoji — monochrome, consistent cross-platform
  - Files: src/components/ConfigManager/ConfigManager.tsx:17
- [CM-20] Tab label reads "Claude" instead of "CLAUDE.md" for the markdown editor tab.
  - Files: src/components/ConfigManager/ConfigManager.tsx:19
- [CM-22] ThreePaneEditor scope headers show actual file paths per tab (e.g. ~/.claude/settings.json, {dir}/CLAUDE.md, {dir}/.claude/agents/) instead of generic directory stubs. Paths normalized to forward slashes via formatScopePath().
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:19, src/lib/paths.ts:89
- [CM-23] MarkdownPane preview toggle: footer has Preview/Edit button (left-aligned via margin-right:auto). Preview mode renders markdown via ReactMarkdown with dark-themed styles for headings, code, tables, blockquotes, lists, and links.
  - Files: src/components/ConfigManager/MarkdownPane.tsx:86, src/components/ConfigManager/ConfigManager.css:1086
- [CM-24] Unified Settings Reference: full-width panel below the 3 editor columns, alphabetically sorted in a 3-column CSS grid (left-to-right flow). Type badges (boolean=blue, string=green, number=purple, enum=purple, array=yellow, object=clay), search/filter, click-to-insert into the active scope's editor, 2-line CSS-clamped descriptions with full text on hover, isSet highlight when key exists in active scope. Collapse state persisted to localStorage.
- [CM-25] Settings validation footer: shows 'Valid' when JSON is well-formed with all recognized keys. Unknown keys show names inline (up to 3, then '+N more') with a tooltip explaining schema source status (schemastore.org loaded vs CLI-only vs limited). Type mismatches show key, expected type, and actual type. Each validation segment is a separate span so tooltips are correctly scoped.
  - Files: src/components/ConfigManager/SettingsPane.tsx:298, src/lib/settingsSchema.ts:295
- [CM-26] PluginsTab: unified tile UI for installed + marketplace plugins. 3-column responsive grid (minmax 200px). Installed tiles enriched via useMemo cross-reference with available list (description, install count). Color-coded popularity: orange (--accent) 10K+, purple (--accent-tertiary) 1K+, blue (--accent-secondary) <1K. Sort select (Most popular / A-Z). Installed sorted enabled-first then alphabetical. Disabled tiles at 0.55 opacity. Scope selector retained (real CLI feature). Marketplace always visible (collapsible toggle removed).
  - Files: src/components/ConfigManager/PluginsPane.tsx, src/components/ConfigManager/ConfigManager.css
