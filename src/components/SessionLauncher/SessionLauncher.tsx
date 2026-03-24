import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { dlog } from "../../lib/debugLog";
import type { CliOption, CliCommand } from "../../store/settings";
import { dirToTabName, computeHeatLevel, getHeatStyle } from "../../lib/claude";
import {
  type SessionConfig,
  type PermissionMode,
  DEFAULT_SESSION_CONFIG,
} from "../../types/session";
import { IconReturn, IconFolder, IconModelDiamond, IconLock, IconLightning } from "../Icons/Icons";
import "./SessionLauncher.css";

// ── Option definitions ──────────────────────────────────────────────

const MODEL_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

const PERM_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Accept" },
  { value: "planMode", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
  { value: "dontAsk", label: "Don't Ask" },
];

const EFFORT_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Med" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

// Flags with dedicated UI controls — exclude from the options grid
const DEDICATED_FLAGS = new Set([
  "--model", "--permission-mode", "--effort",
  "--dangerously-skip-permissions", "--project-dir",
  "--resume", "--session-id", "--continue",
]);

// Flags that don't start an interactive session
const NON_SESSION_FLAGS = new Set([
  "--version", "-V", "--help", "-h",
  "--print", "-p",          // Non-interactive print mode
  "--output-format",        // Only useful with --print
  "--input-format",         // Piped input
  "--no-input",             // Disables interactive input
]);

// ── Main component ──────────────────────────────────────────────────

export function SessionLauncher() {
  const createSession = useSessionStore((s) => s.createSession);
  const claudePath = useSessionStore((s) => s.claudePath);
  const { recentDirs, lastConfig, savedDefaults, setShowLauncher, addRecentDir, removeRecentDir, setLastConfig, setSavedDefaults } =
    useSettingsStore();
  const cliCapabilities = useSettingsStore((s) => s.cliCapabilities);
  const commandUsage = useSettingsStore((s) => s.commandUsage);

  // savedDefaults (explicit "Save defaults") takes priority over lastConfig (auto-saved on launch)
  const defaults = savedDefaults ?? lastConfig;
  const [config, setConfig] = useState<SessionConfig>({
    ...DEFAULT_SESSION_CONFIG,
    ...defaults,
    // Preserve resume from lastConfig (configure flow sets this one-shot)
    ...(lastConfig.resumeSession ? { resumeSession: lastConfig.resumeSession, workingDir: lastConfig.workingDir } : {}),
    // Clear one-shot fields
    continueSession: false,
    sessionId: null,
    runMode: false,
  });
  const isUtilityRef = useRef(false);
  const mountedRef = useRef(false);
  const [showCliOptions, setShowCliOptions] = useState(true);
  const [showUtility, setShowUtility] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);

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

  const [commandLine, setCommandLine] = useState(() => buildFullCommand(config, defaults.extraFlags || ""));

  // Regenerate command line when config dropdowns change (skip on mount and in utility mode)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (isUtilityRef.current) return;
    setCommandLine(buildFullCommand(config));
  }, [config.model, config.permissionMode, config.effort, config.dangerouslySkipPermissions, config.projectDir, config.resumeSession, buildFullCommand]);

  useEffect(() => {
    const el = document.getElementById("launcher-path");
    el?.focus();
  }, []);

  // Deduplicate recent directories (case-insensitive, slash-invariant)
  const uniqueRecentDirs = useMemo(() => {
    const seen = new Set<string>();
    return recentDirs.filter(dir => {
      const normalized = dir.replace(/\\/g, "/").toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }, [recentDirs]);

  const updateConfig = useCallback(
    <K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const filteredCliOptions = useMemo((): CliOption[] => {
    return (cliCapabilities.options || [])
      .filter((opt) => !DEDICATED_FLAGS.has(opt.flag) && !NON_SESSION_FLAGS.has(opt.flag))
      .sort((a, b) => a.flag.localeCompare(b.flag));
  }, [cliCapabilities.options]);

  const commandTokens = useMemo((): string[] => {
    return commandLine.split(/\s+/);
  }, [commandLine]);

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

  // CLI subcommands sorted by usage frequency (most-used first, then alphabetical)
  const sortedCliCommands = useMemo((): CliCommand[] => {
    return [...(cliCapabilities.commands || [])].sort((a, b) => {
      const aCount = commandUsage[a.name] || 0;
      const bCount = commandUsage[b.name] || 0;
      if (aCount !== bCount) return bCount - aCount;
      return a.name.localeCompare(b.name);
    });
  }, [cliCapabilities.commands, commandUsage]);

  const cliCommandMaxCount = useMemo(() => {
    return Math.max(...sortedCliCommands.map((c) => commandUsage[c.name] || 0), 0);
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
    return { ...config, extraFlags: extra };
  }, [config, commandLine, buildFullCommand]);

  const closeSession = useSessionStore((s) => s.closeSession);

  const handleLaunch = useCallback(async () => {
    if (!isNonSessionCommand && !launchConfig.workingDir.trim()) return;
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
    if (selected) updateConfig("workingDir", selected);
  }, [config.workingDir, updateConfig]);

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
            <h2>Claude CLI Not Found</h2>
            <p className="launcher-error-msg">
              Claude Code must be installed to use Claude Tabs.
            </p>
            <p>
              Install it with: <code>npm install -g @anthropic-ai/claude-code</code>
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

        {/* Recent directories — only for new sessions */}
        {!isResuming && uniqueRecentDirs.length > 0 && (
          <div className="launcher-recent">
            <div className="launcher-recent-chips">
              {uniqueRecentDirs.map((dir) => (
                <button
                  key={dir}
                  className="recent-chip"
                  onClick={() => updateConfig("workingDir", dir)}
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

        {/* Compact selects row: Model, Permissions, Effort, toggle pills */}
        <div className={`launcher-selects${isNonSessionCommand ? " launcher-selects-disabled" : ""}`}>
          <label className="launcher-select-group">
            <span className="launcher-select-icon" title="Model"><IconModelDiamond size={13} /></span>
            <select
              className="launcher-select"
              value={config.model ?? ""}
              onChange={(e) => updateConfig("model", e.target.value || null)}
              disabled={isNonSessionCommand}
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={String(opt.value)} value={opt.value ?? ""}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="launcher-select-group">
            <span className="launcher-select-icon" title="Permissions"><IconLock size={13} /></span>
            <select
              className="launcher-select"
              value={config.permissionMode}
              onChange={(e) => updateConfig("permissionMode", e.target.value as PermissionMode)}
              disabled={isNonSessionCommand}
            >
              {PERM_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="launcher-select-group">
            <span className="launcher-select-icon" title="Effort"><IconLightning size={13} /></span>
            <select
              className="launcher-select"
              value={config.effort ?? ""}
              onChange={(e) => updateConfig("effort", e.target.value || null)}
              disabled={isNonSessionCommand}
            >
              {EFFORT_OPTIONS.map((opt) => (
                <option key={String(opt.value)} value={opt.value ?? ""}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <button
            className={`launcher-toggle-pill${config.projectDir ? " launcher-toggle-pill-on launcher-toggle-sandbox" : ""}`}
            onClick={() => updateConfig("projectDir", !config.projectDir)}
            aria-pressed={config.projectDir}
            title="Restrict Claude to the working directory (--project-dir)"
            type="button"
          >
            Sandbox
          </button>

          <button
            className={`launcher-toggle-pill${config.dangerouslySkipPermissions ? " launcher-toggle-pill-on launcher-toggle-skip" : ""}`}
            onClick={() => updateConfig("dangerouslySkipPermissions", !config.dangerouslySkipPermissions)}
            aria-pressed={config.dangerouslySkipPermissions}
            title="Skip all permission prompts (--dangerously-skip-permissions)"
            type="button"
          >
            Skip
          </button>

        </div>

        {/* CLI Options header (always shown) with save defaults on the right */}
        <div className="launcher-section">
          <div className="launcher-cli-header">
            {!isNonSessionCommand && (filteredCliOptions.length > 0 || (cliCapabilities.commands || []).length > 0) ? (
              <button
                className="launcher-cli-toggle"
                onClick={() => setShowCliOptions((v) => !v)}
                type="button"
              >
                {showCliOptions ? "\u25BE" : "\u25B8"} CLI Options
              </button>
            ) : <span />}
            <button
              className={`launcher-save-defaults${defaultsSaved ? " launcher-save-defaults-saved" : ""}`}
              onClick={() => { setSavedDefaults(launchConfig); setDefaultsSaved(true); setTimeout(() => setDefaultsSaved(false), 2000); }}
              disabled={isNonSessionCommand}
              type="button"
            >
              {defaultsSaved ? "Saved" : "Save defaults"}
            </button>
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
                  {sortedCliCommands.map((cmd) => {
                    const heat = computeHeatLevel(commandUsage[cmd.name] || 0, cliCommandMaxCount);
                    return (
                      <button
                        key={cmd.name}
                        className="launcher-cli-pill launcher-cli-pill-cmd"
                        style={getHeatStyle(heat)}
                        onClick={() => setCommandLine((prev) => {
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
              rows={2}
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
