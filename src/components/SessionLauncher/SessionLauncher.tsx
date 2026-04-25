import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { dlog } from "../../lib/debugLog";
import type { CliOption, CliCommand } from "../../store/settings";
import { dirToTabName, computeHeatLevel, heatClassName } from "../../lib/claude";
import { parseWorktreePath, normalizePath } from "../../lib/paths";
import {
  type SessionConfig,
  type PermissionMode,
  DEFAULT_SESSION_CONFIG,
  ANTHROPIC_EFFORTS,
  ANTHROPIC_MODELS,
} from "../../types/session";
import { IconReturn, IconFolder, IconModelDiamond, IconLock, IconLightning, IconSkull, IconBulldozer, IconDocument } from "../Icons/Icons";
import { PillGroup } from "../PillGroup/PillGroup";
import { Dropdown } from "../Dropdown/Dropdown";
import "./SessionLauncher.css";

// ── Option definitions ──────────────────────────────────────────────

const PERM_PILLS: Array<{ value: PermissionMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Accept" },
  { value: "planMode", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
  { value: "dontAsk", label: "Don't Ask" },
];

// [SL-11] Flags with dedicated UI controls excluded from the options grid
const DEDICATED_FLAGS = new Set([
  "--model", "--permission-mode", "--effort",
  "--dangerously-skip-permissions", "--project-dir",
  "--resume", "--session-id", "--continue",
]);

// [SL-14] Non-session flags rendered in separate Utility Commands section
const NON_SESSION_FLAGS = new Set([
  "--version", "-V", "--help", "-h",
  "--print", "-p",          // Non-interactive print mode
  "--output-format",        // Only useful with --print
  "--input-format",         // Piped input
  "--no-input",             // Disables interactive input
]);

// ── Main component ──────────────────────────────────────────────────

// [SL-01] Modal for new session or resume
// [SL-09] Config restore: savedDefaults with lastConfig fallback, clears one-shot fields
export function SessionLauncher() {
  const createSession = useSessionStore((s) => s.createSession);
  const claudePath = useSessionStore((s) => s.claudePath);
  const { recentDirs, lastConfig, savedDefaults, setShowLauncher, addRecentDir, removeRecentDir, setLastConfig, setSavedDefaults } =
    useSettingsStore();
  const cliCapabilities = useSettingsStore((s) => s.cliCapabilities);
  const commandUsage = useSettingsStore((s) => s.commandUsage);
  const savedPrompts = useSettingsStore((s) => s.savedPrompts);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);

  // When resuming, use session-specific settings from lastConfig (set by handleConfigure);
  // otherwise savedDefaults (explicit "Save defaults") takes priority over lastConfig.
  // Layer workspace-specific defaults on top when available for the resolved workingDir.
  const defaults = lastConfig.resumeSession ? lastConfig : (savedDefaults ?? lastConfig);
  const wsInitKey = (() => {
    const wt = parseWorktreePath(defaults.workingDir);
    return normalizePath(wt ? wt.projectRoot : defaults.workingDir).toLowerCase();
  })();
  const wsInitDefaults = wsInitKey ? useSettingsStore.getState().workspaceDefaults[wsInitKey] : undefined;
  const [config, setConfig] = useState<SessionConfig>({
    ...DEFAULT_SESSION_CONFIG,
    ...defaults,
    ...(wsInitDefaults ?? {}),
    workingDir: defaults.workingDir,
    continueSession: false,
    sessionId: null,
    runMode: false,
    forkSession: false,
  });
  const isUtilityRef = useRef(false);
  const mountedRef = useRef(false);
  const [showCliOptions, setShowCliOptions] = useState(true);
  const [showUtility, setShowUtility] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState<string>("");
  const [promptMode, setPromptMode] = useState<"replace" | "append">("replace");
  const [launchError, setLaunchError] = useState<string>("");

  // Unified command line: editable string that starts from config selections.
  // User can edit freely; reset button regenerates from current dropdowns.
  const buildFullCommand = useCallback((cfg: SessionConfig, extra?: string) => {
    const parts: string[] = ["claude"];
    if (cfg.model) parts.push("--model", cfg.model);
    if (cfg.permissionMode !== "default") parts.push("--permission-mode", cfg.permissionMode);
    if (cfg.effort) parts.push("--effort", cfg.effort);
    if (cfg.dangerouslySkipPermissions) parts.push("--dangerously-skip-permissions");
    if (cfg.projectDir) parts.push("--project-dir", cfg.workingDir || ".");
    if (cfg.resumeSession) parts.push("--resume", cfg.resumeSession);
    if (extra?.trim()) parts.push(extra.trim());
    return parts.join(" ");
  }, []);

  const [commandLine, setCommandLine] = useState(() => buildFullCommand(config, config.extraFlags || ""));

  // Regenerate command line when config dropdowns change (skip on mount and in utility mode)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (isUtilityRef.current) return;
    setCommandLine(buildFullCommand(config, config.extraFlags || undefined));
  }, [config.model, config.permissionMode, config.effort, config.dangerouslySkipPermissions, config.projectDir, config.resumeSession, config.extraFlags, buildFullCommand]);

  useEffect(() => {
    const el = document.getElementById("launcher-path");
    el?.focus();
  }, []);

  // Deduplicate recent directories (case-insensitive, slash-invariant).
  // Worktree paths are collapsed to their project root so they don't appear
  // as separate (identical-looking) entries.
  const uniqueRecentDirs = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const dir of recentDirs) {
      const wt = parseWorktreePath(dir);
      const resolved = normalizePath(wt ? wt.projectRoot : dir);
      const key = resolved.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(resolved);
    }
    return result;
  }, [recentDirs]);

  const updateConfig = useCallback(
    <K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) => {
      if (key === "workingDir") setLaunchError("");
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // [SL-21] Load workspace-specific defaults when switching workspace via browse or recent chip
  const applyWorkspaceDefaults = useCallback((dir: string) => {
    const wt = parseWorktreePath(dir);
    const wsKey = normalizePath(wt ? wt.projectRoot : dir).toLowerCase();
    const wsDefaults = wsKey
      ? useSettingsStore.getState().workspaceDefaults[wsKey]
      : undefined;
    if (wsDefaults) {
      setConfig((prev) => ({
        ...prev,
        ...wsDefaults,
        workingDir: dir,
        resumeSession: null,
        continueSession: false,
        sessionId: null,
        runMode: false,
        forkSession: false,
      }));
    } else {
      // No workspace defaults — reset to global baseline so settings from
      // a previously-selected workspace don't leak into the new one
      const { savedDefaults: sd, lastConfig: lc } = useSettingsStore.getState();
      const baseline = sd ?? lc;
      setConfig({
        ...DEFAULT_SESSION_CONFIG,
        ...baseline,
        workingDir: dir,
        resumeSession: null,
        continueSession: false,
        sessionId: null,
        runMode: false,
        forkSession: false,
      });
    }
    setLaunchError("");
  }, []);

  const handlePermChange = useCallback((value: PermissionMode | null) => {
    updateConfig("permissionMode", value ?? "default");
  }, [updateConfig]);

  // Model + effort options come from the active CLI's adapter. Claude
  // is hard-coded for the no-binary case; Codex is fetched from the
  // running binary's `codex debug models`. Effects refresh when `cli`
  // changes.
  const [adapterModels, setAdapterModels] = useState<Array<{ value: string; label: string }>>([]);
  const [adapterEfforts, setAdapterEfforts] = useState<Array<{ value: string; label: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    if (config.cli === "claude") {
      setAdapterModels(ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.id })));
      setAdapterEfforts(ANTHROPIC_EFFORTS.map((e) => ({ value: e.value, label: e.label })));
      return () => { cancelled = true; };
    }
    invoke<{ models: Array<{ id: string; displayName: string }>; effortLevels: Array<{ id: string; displayName: string }> }>(
      "cli_launch_options",
      { cli: config.cli }
    )
      .then((opts) => {
        if (cancelled) return;
        setAdapterModels(opts.models.map((m) => ({ value: m.id, label: m.displayName || m.id })));
        setAdapterEfforts(opts.effortLevels.map((e) => ({ value: e.id, label: e.displayName || e.id })));
      })
      .catch(() => {
        if (cancelled) return;
        setAdapterModels([]);
        setAdapterEfforts([]);
      });
    return () => { cancelled = true; };
  }, [config.cli]);

  const modelOptions = adapterModels;
  const effortOptions = adapterEfforts;

  const handleModelSelect = useCallback((value: string) => {
    updateConfig("model", value || null);
  }, [updateConfig]);

  const handleEffortSelect = useCallback((value: string) => {
    updateConfig("effort", value || null);
  }, [updateConfig]);

  const filteredCliOptions = useMemo((): CliOption[] => {
    return (cliCapabilities.options || [])
      .filter((opt) => !DEDICATED_FLAGS.has(opt.flag) && !NON_SESSION_FLAGS.has(opt.flag))
      .sort((a, b) => a.flag.localeCompare(b.flag));
  }, [cliCapabilities.options]);

  const commandTokens = useMemo((): string[] => {
    return commandLine.split(/\s+/);
  }, [commandLine]);

  // [SL-12] Active flag indicators: pills highlight when flag is in command line
  const activeFlags = useMemo((): Set<string> => {
    return new Set(commandTokens.filter((t) => t.startsWith("-")));
  }, [commandTokens]);

  const nonSessionFlags = useMemo((): CliOption[] => {
    return (cliCapabilities.options || []).filter((opt) => NON_SESSION_FLAGS.has(opt.flag));
  }, [cliCapabilities.options]);

  const isNonSessionCommand = useMemo((): boolean => {
    for (const flag of NON_SESSION_FLAGS) {
      if (activeFlags.has(flag)) return true;
    }
    const afterClaude = commandTokens.slice(commandTokens.indexOf("claude") + 1);
    const firstNonFlag = afterClaude.find((t) => !t.startsWith("-"));
    if (firstNonFlag) {
      return (cliCapabilities.commands || []).some((c) => c.name === firstNonFlag);
    }
    return false;
  }, [commandTokens, activeFlags, cliCapabilities.commands]);

  isUtilityRef.current = isNonSessionCommand;

  // [SL-10] CLI command pills sorted by usage frequency (same heat gradient as Command Bar)
  const sortedCliCommands = useMemo((): CliCommand[] => {
    return [...(cliCapabilities.commands || [])].sort((a, b) => {
      const aCount = commandUsage[a.name] || 0;
      const bCount = commandUsage[b.name] || 0;
      if (aCount !== bCount) return bCount - aCount;
      return a.name.localeCompare(b.name);
    });
  }, [cliCapabilities.commands, commandUsage]);

  const cliUsedCommandCount = useMemo(() => {
    return sortedCliCommands.reduce((n, c) => n + ((commandUsage[c.name] || 0) > 0 ? 1 : 0), 0);
  }, [sortedCliCommands, commandUsage]);

  // Extract extra flags from the command line (anything the user typed beyond
  // what the dropdowns generate). We parse the command line to find extra args.
  const launchConfig = useMemo((): SessionConfig => {
    const generated = buildFullCommand(config);
    // If user edited the command line, the extra part is whatever they added
    let extra: string | null = null;
    if (commandLine.startsWith(generated)) {
      extra = commandLine.slice(generated.length).trim() || null;
    } else {
      // User edited the generated part too — pass entire command line as extra
      // and let the Rust arg builder handle the structured fields
      const parts = commandLine.replace(/^claude\s*/, "").trim();
      extra = parts || null;
    }
    // Apply selected system prompt
    const selectedPrompt = savedPrompts.find((p) => p.id === selectedPromptId);
    const promptOverrides: Partial<SessionConfig> = {};
    if (selectedPrompt) {
      if (promptMode === "replace") {
        promptOverrides.systemPrompt = selectedPrompt.text;
        promptOverrides.appendSystemPrompt = null;
      } else {
        promptOverrides.systemPrompt = null;
        promptOverrides.appendSystemPrompt = selectedPrompt.text;
      }
    }
    return { ...config, extraFlags: extra, ...promptOverrides };
  }, [config, commandLine, buildFullCommand, savedPrompts, selectedPromptId, promptMode]);

  const closeSession = useSessionStore((s) => s.closeSession);

  const handleLaunch = useCallback(async () => {
    if (!isNonSessionCommand && !launchConfig.workingDir.trim()) return;
    // [SL-19] Validate that the working directory actually exists on disk
    if (!isNonSessionCommand && launchConfig.workingDir.trim()) {
      const exists = await invoke<boolean>("dir_exists", { path: normalizePath(launchConfig.workingDir.trim()) });
      if (!exists) {
        setLaunchError("Directory does not exist");
        return;
      }
    }
    const finalConfig: SessionConfig = isNonSessionCommand
      ? { ...launchConfig, runMode: true, model: null, permissionMode: "default", effort: null, dangerouslySkipPermissions: false, projectDir: false }
      : { ...launchConfig, runMode: false };
    const storedName = finalConfig.resumeSession
      ? useSettingsStore.getState().sessionNames[finalConfig.resumeSession]
      : undefined;
    const name = isNonSessionCommand
      ? commandTokens.find(t => t !== "claude" && !t.startsWith("-"))
        || commandTokens.find(t => t.startsWith("--"))
        || "run"
      : storedName || (launchConfig.workingDir ? dirToTabName(launchConfig.workingDir) : "run");
    if (finalConfig.workingDir) addRecentDir(finalConfig.workingDir);
    // Save config as defaults but strip one-shot resume fields and runMode —
    // these are per-launch, not persistent defaults.
    setLastConfig({ ...finalConfig, resumeSession: null, continueSession: false, runMode: false });
    try {
      // If relaunching an existing session, close it first
      const replaceId = useSettingsStore.getState().replaceSessionId;
      if (replaceId) {
        await closeSession(replaceId);
        useSettingsStore.getState().setReplaceSessionId(null);
      }
      await createSession(name, finalConfig);
      setShowLauncher(false);
    } catch (err) {
      dlog("launcher", null, `create session failed: ${err}`, "ERR");
    }
  }, [launchConfig, isNonSessionCommand, commandTokens, createSession, closeSession, setShowLauncher, addRecentDir, setLastConfig]);

  const handleBrowse = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select project directory",
      defaultPath: config.workingDir || undefined,
    });
    if (selected) applyWorkspaceDefaults(selected);
  }, [config.workingDir, applyWorkspaceDefaults]);

  // Dismiss launcher: clears replace target and one-shot resume flags
  const dismissLauncher = useCallback(() => {
    const store = useSettingsStore.getState();
    store.setReplaceSessionId(null);
    if (store.lastConfig.resumeSession) {
      store.setLastConfig({ ...store.lastConfig, resumeSession: null, continueSession: false });
    }
    setShowLauncher(false);
  }, [setShowLauncher]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) handleLaunch();
      if (e.key === "Escape") dismissLauncher();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleLaunch, dismissLauncher]);

  // [SL-13] Toggle behavior: clicking active pill removes flag; clicking inactive pill adds it
  const handleCliPillClick = useCallback(({ flag, argName }: CliOption) => {
    setCommandLine((prev) => {
      const tokens = prev.split(/\s+/);
      const idx = tokens.indexOf(flag);
      if (idx !== -1) {
        tokens.splice(idx, argName ? 2 : 1);
        return tokens.join(" ");
      }
      return prev + (argName ? ` ${flag} ` : ` ${flag}`);
    });
  }, []);

  // [SL-15] Utility mode mutual exclusion: non-session flag click replaces entire command line; clicking again restores; reset button (↻) escapes utility mode
  const handleNonSessionFlagClick = useCallback(({ flag }: CliOption) => {
    setCommandLine((prev) => {
      const tokens = prev.split(/\s+/);
      if (tokens.includes(flag)) {
        // Toggling off → restore session command
        return buildFullCommand(config);
      }
      // Toggling on → replace entire command
      return `claude ${flag}`;
    });
  }, [config, buildFullCommand]);

  const handleResetCommand = useCallback(() => {
    setCommandLine(buildFullCommand(config));
  }, [config, buildFullCommand]);

  // ── CLI not found ──

  if (!claudePath) {
    return (
      <div className="launcher-overlay" onClick={dismissLauncher}>
        <div className="launcher" onClick={(e) => e.stopPropagation()}>
          <div className="launcher-error-content">
            <h2>No CLI installed</h2>
            <p className="launcher-error-msg">
              Claude Tabs needs at least one of <code>claude</code> (Claude Code) or
              <code> codex</code> (OpenAI Codex) on your <code>$PATH</code>.
            </p>
            <p>
              Claude Code: <code>npm install -g @anthropic-ai/claude-code</code><br />
              Codex: see <code>github.com/openai/codex</code>
            </p>
            <button className="btn-secondary launcher-error-close" onClick={dismissLauncher}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isResuming = !!config.resumeSession;

  let launchLabel = "Launch";
  if (isResuming) launchLabel = "Resume";
  else if (isNonSessionCommand) launchLabel = "Run";

  // ── Main launcher ──

  return (
    <div className="launcher-overlay" onClick={dismissLauncher}>
      <div className="launcher" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="launcher-header">
          <span className="launcher-title">{isResuming ? "Resume Session" : "New Session"}</span>
          <button className="launcher-close" onClick={dismissLauncher} type="button">&times;</button>
        </div>

        {/* Resume banner or path input */}
        {isResuming ? (
          <div className="launcher-resume-banner">
            <span className="launcher-resume-banner-icon"><IconReturn size={16} /></span>
            <span className="launcher-resume-banner-text">
              Resuming in <strong>{dirToTabName(config.workingDir)}</strong>
            </span>
          </div>
        ) : (
          <div className="launcher-path-row">
            <input
              id="launcher-path"
              className="launcher-path-input"
              type="text"
              value={config.workingDir}
              onChange={(e) => updateConfig("workingDir", e.target.value)}
              placeholder="Path to project..."
              autoComplete="off"
            />
            <button className="launcher-browse-btn" onClick={handleBrowse} title="Browse" type="button">
              <IconFolder size={14} />
            </button>
          </div>
        )}
        {launchError && <div className="launcher-path-error">{launchError}</div>}

        {/* Recent directories — only for new sessions */}
        {!isResuming && uniqueRecentDirs.length > 0 && (
          <div className="launcher-recent">
            <div className="launcher-recent-chips">
              {uniqueRecentDirs.map((dir) => (
                <button
                  key={dir}
                  className="recent-chip"
                  onClick={() => applyWorkspaceDefaults(dir)}
                  onContextMenu={(e) => { e.preventDefault(); removeRecentDir(dir); }}
                  title={`${dir}\nRight-click to remove`}
                  type="button"
                >
                  {dirToTabName(dir)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* CLI selector pills — choose Claude Code or Codex per session */}
        <div className="launcher-cli-row">
          <button
            type="button"
            className={`launcher-cli-pill${config.cli === "claude" ? " launcher-cli-pill--active" : ""}`}
            onClick={() => updateConfig("cli", "claude")}
            disabled={isNonSessionCommand}
          >
            Claude Code
          </button>
          <button
            type="button"
            className={`launcher-cli-pill${config.cli === "codex" ? " launcher-cli-pill--active" : ""}`}
            onClick={() => updateConfig("cli", "codex")}
            disabled={isNonSessionCommand}
          >
            Codex
          </button>
        </div>

        {/* Pill selectors — inline, wrapping */}
        <div className={`launcher-pills-section${isNonSessionCommand ? " launcher-selects-disabled" : ""}`}>
          <div className="launcher-pills-row">
            <span className="launcher-pill-icon" title="Model"><IconModelDiamond size={13} /></span>
            <Dropdown
              className="launcher-select"
              value={config.model ?? ""}
              onChange={handleModelSelect}
              disabled={isNonSessionCommand}
              ariaLabel="Model"
              options={[{ value: "", label: "default" }, ...modelOptions.map((m) => ({ value: m.value, label: m.label }))]}
            />
            <span className="launcher-pill-icon" title="Effort"><IconLightning size={13} /></span>
            <Dropdown
              className="launcher-select"
              value={config.effort ?? ""}
              onChange={handleEffortSelect}
              disabled={isNonSessionCommand}
              ariaLabel="Effort"
              options={[{ value: "", label: "default" }, ...effortOptions.map((e) => ({ value: e.value, label: e.label }))]}
            />

            <div className="launcher-prompt-group">
              {savedPrompts.length > 0 ? (
                <>
                  <span className="launcher-pill-icon" title="System Prompt"><IconDocument size={13} /></span>
                  <div className="launcher-prompt-slot">
                    <Dropdown
                      className="launcher-select launcher-prompt-select"
                      value={selectedPromptId}
                      onChange={setSelectedPromptId}
                      disabled={isNonSessionCommand}
                      title="System prompt"
                      ariaLabel="System Prompt"
                      options={[{ value: "", label: "Default Prompt" }, ...savedPrompts.map((p) => ({ value: p.id, label: p.name }))]}
                    />
                    {selectedPromptId && (
                      <button
                        className={`launcher-toggle-pill launcher-prompt-mode${promptMode === "append" ? " launcher-toggle-pill-on" : ""}`}
                        onClick={() => setPromptMode((m) => m === "replace" ? "append" : "replace")}
                        title={promptMode === "replace" ? "Replace system prompt" : "Append to system prompt"}
                        type="button"
                      >
                        {promptMode === "replace" ? "Replace" : "Append"}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <button
                  className="launcher-toggle-pill launcher-prompt-config-btn"
                  onClick={() => setShowConfigManager("prompts")}
                  title="Open system prompt configuration"
                  type="button"
                >
                  <IconDocument size={12} /> System Prompt
                </button>
              )}
            </div>
          </div>

          <div className="launcher-pills-row launcher-pills-row-secondary">
            <div className="launcher-permissions-group">
              <span className="launcher-pill-icon" title="Permissions"><IconLock size={13} /></span>
              <PillGroup
                options={PERM_PILLS}
                selected={config.permissionMode === "default" ? null : config.permissionMode}
                onChange={handlePermChange}
                disabled={isNonSessionCommand}
              />
            </div>

            <button
              className={`launcher-toggle-pill${config.dangerouslySkipPermissions ? " launcher-toggle-pill-on launcher-toggle-skip" : ""}`}
              onClick={() => updateConfig("dangerouslySkipPermissions", !config.dangerouslySkipPermissions)}
              aria-pressed={config.dangerouslySkipPermissions}
              title="Skip all permission prompts (--dangerously-skip-permissions)"
              type="button"
            >
              <IconSkull size={12} /> Skip
            </button>
            <button
              className={`launcher-toggle-pill${config.projectDir ? " launcher-toggle-pill-on launcher-toggle-sandbox" : ""}`}
              onClick={() => updateConfig("projectDir", !config.projectDir)}
              aria-pressed={config.projectDir}
              title="Restrict Claude to the working directory (--project-dir)"
              type="button"
            >
              <IconBulldozer size={12} /> Sandbox
            </button>
          </div>
        </div>

        {/* CLI Options header (always shown) with TAP/TFC and save defaults */}
        <div className="launcher-section">
          <div className="launcher-cli-header">
            <div className="launcher-cli-header-left">
              {!isNonSessionCommand && (filteredCliOptions.length > 0 || (cliCapabilities.commands || []).length > 0) ? (
                <button
                  className="launcher-cli-toggle"
                  onClick={() => setShowCliOptions((v) => !v)}
                  type="button"
                >
                  {showCliOptions ? "\u25BE" : "\u25B8"} CLI Options
                </button>
              ) : <span />}
            </div>
            <div className="launcher-cli-header-right">
              <button
                className={`launcher-save-defaults${defaultsSaved ? " launcher-save-defaults-saved" : ""}`}
                onClick={() => { setSavedDefaults(launchConfig); setDefaultsSaved(true); setTimeout(() => setDefaultsSaved(false), 2000); }}
                disabled={isNonSessionCommand}
                type="button"
              >
                {defaultsSaved ? "Saved" : "Save defaults"}
              </button>
            </div>
          </div>
          {showCliOptions && !isNonSessionCommand && filteredCliOptions.length > 0 && (
            <div className="launcher-cli-grid">
              {filteredCliOptions.map((opt) => (
                <button
                  key={opt.flag}
                  className={`launcher-cli-pill${activeFlags.has(opt.flag) ? " launcher-cli-pill-active" : ""}`}
                  onClick={() => handleCliPillClick(opt)}
                  title={opt.description}
                  type="button"
                >
                  {opt.flag}
                </button>
              ))}
            </div>
          )}

          {/* Utility Commands — collapsed by default */}
          {(nonSessionFlags.length > 0 || sortedCliCommands.length > 0) && (
            <>
              <button
                className="launcher-cli-toggle launcher-cli-utility-toggle"
                onClick={() => setShowUtility((v) => !v)}
                type="button"
              >
                {showUtility ? "\u25BE" : "\u25B8"} Utility Commands
              </button>
              {showUtility && (
                <div className="launcher-cli-grid">
                  {nonSessionFlags.map((opt) => (
                    <button
                      key={opt.flag}
                      className={`launcher-cli-pill launcher-cli-pill-nonsession${activeFlags.has(opt.flag) ? " launcher-cli-pill-active" : ""}`}
                      onClick={() => handleNonSessionFlagClick(opt)}
                      title={opt.description}
                      type="button"
                    >
                      {opt.flag}
                    </button>
                  ))}
                  {sortedCliCommands.map((cmd, idx) => {
                    const heatClass = heatClassName(computeHeatLevel(commandUsage[cmd.name] || 0, idx, cliUsedCommandCount));
                    return (
                      <button
                        key={cmd.name}
                        className={`launcher-cli-pill launcher-cli-pill-cmd ${heatClass}`}
                        onClick={() => setCommandLine((prev) => {
                          // [SL-16] Subcommand toggle: clicking a subcommand replaces command line with `claude <cmd>`; clicking again resets to generated command
                          const base = buildFullCommand(config);
                          return prev.trim() === `claude ${cmd.name}` ? base : `claude ${cmd.name}`;
                        })}
                        title={cmd.description}
                        type="button"
                      >
                        {cmd.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Command input — single editable command line */}
        <div className="launcher-cmd-block">
          <span className="launcher-cmd-label">CLI Command</span>
          <div className="launcher-cmd">
            <textarea
              className="launcher-cmd-input"
              value={commandLine}
              onChange={(e) => setCommandLine(e.target.value)}
              spellCheck={false}
              rows={4}
            />
            <button
              className="launcher-cmd-reset"
              onClick={handleResetCommand}
              title="Reset to generated command"
              type="button"
            >
              ↻
            </button>
          </div>
        </div>

        {/* Launch button */}
        <button
          className={`launcher-launch-btn${isNonSessionCommand ? " launcher-launch-btn-run" : ""}`}
          onClick={handleLaunch}
          disabled={!isNonSessionCommand && !launchConfig.workingDir.trim()}
          type="button"
        >
          {launchLabel}
        </button>
      </div>
    </div>
  );
}
