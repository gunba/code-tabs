---
paths:
  - "src/App.tsx"
---

# src/App.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-02 L123] Quick launch: Ctrl+Click + or Ctrl+Shift+T launches without the modal using saved defaults or lastConfig, after clearing resumeSession, forkSession, continueSession, sessionId, and runMode.
  - quickLaunchSession() strips transient one-shot fields before createSession; App.tsx Ctrl+Shift+T delegates to this path.
- [SL-24 L231] Fork into New Tab is available from resumable live/dead tabs and resume-history rows, and creates a separate session immediately instead of replacing or resuming the current tab.
  - App.tsx tab context-menu handler builds a fork config with buildForkSessionConfig(), loading past sessions first when a live tab lacks a captured session id. ResumePicker right-click Fork into New Tab uses buildForkConfigFromPastSession(). Both add the fork workingDir to recents, createSession with a Fork-suffixed name, and leave ordinary resume/configure paths with forkSession false.

## Data Flow

- [DF-04 L54] React re-renders from Zustand store: tab state dots, status bar, subagent cards

## Provider-scoped UI accents
App root, launcher, and config modal carry provider-scoped CSS classes (app-provider-{cli}, provider-scope-{cli}, config-modal-cli-{cli}) that remap --accent / --accent-bg / --accent-hover to the active CLI's brand palette. Each tab also has a per-tab .tab-cli-{cli} scope so inactive Codex tabs keep their teal accent and inactive Claude tabs keep clay.

- [PO-01 L214] App root receives className 'app app-provider-{activeProvider}' (claude|codex) where activeProvider mirrors the active session's config.cli (default 'claude'). SessionLauncher's launcher container adds 'provider-scope-{config.cli}'. ConfigManager's ModalOverlay adds 'config-modal-cli-{configCli}'. Per-tab .tab-cli-{cli} scope (set in App.tsx tab JSX) sets --tab-active-accent + --provider-accent/-bg/-hover from cliClaude / cliCodex constants in theme. App.css selectors .app-provider-claude/.provider-scope-claude/.config-modal-cli-claude (and codex variants) remap --accent, --accent-bg, --accent-hover to the provider palette via :root vars --provider-claude-accent / --provider-codex-accent (set by applyTheme from theme.cliClaude/cliClaudeBg + theme.accentHover; theme.cliCodex/cliCodexBg + theme.cliCodexHover).
  - src/App.tsx:L401 (app-provider class), src/App.css:L7 (provider-scope/.app-provider/.config-modal-cli rules), src/App.css:L82 (.tab.tab-cli-codex provider override), src/lib/theme.ts:L37 (cliCodexHover field), src/lib/theme.ts:L142-148 (provider CSS vars), src/components/SessionLauncher/SessionLauncher.tsx:L488 (provider-scope class), src/components/ConfigManager/ConfigManager.tsx:L345 (config-modal-cli class), index.html:L48 (root provider vars defaults)

## Project Conventions

- [LO-01 L281] Main window layout: tab bar, subagent bar, terminal, command bar (slash commands + skill pills + command history), status bar
