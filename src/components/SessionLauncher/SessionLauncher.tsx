import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { dlog } from "../../lib/debugLog";
import type { CliOption, CliCommand } from "../../store/settings";
import { dirToTabName, computeHeatLevel, heatClassName, MODEL_FAMILIES, extractModelFamily, isModel1m, resolveModelId } from "../../lib/claude";
import {
  type SessionConfig,
  type PermissionMode,
  DEFAULT_SESSION_CONFIG,
} from "../../types/session";
import { IconReturn, IconFolder, IconModelDiamond, IconLock, IconLightning, IconSkull, IconBulldozer, IconAntenna, IconTraffic } from "../Icons/Icons";
import { PillGroup } from "../PillGroup/PillGroup";
import "./SessionLauncher.css";

// ── Option definitions ──────────────────────────────────────────────

const MODEL_PILLS = MODEL_FAMILIES.map(f => ({ value: f.keyword, label: f.label }));

const MODEL_COLOR_MAP: Record<string, string> = Object.fromEntries(
  MODEL_FAMILIES.map(f => [f.keyword, f.color])
);
const modelColorFn = (value: string) => MODEL_COLOR_MAP[value] ?? "var(--accent)";

const PERM_PILLS: Array<{ value: PermissionMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Accept" },
  { value: "planMode", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
  { value: "dontAsk", label: "Don't Ask" },
];

const EFFORT_PILLS: Array<{ value: string; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Med" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const CONTEXT_PILLS: Array<{ value: "200k" | "1m"; label: string }> = [
  { value: "200k", label: "200k" },
  { value: "1m", label: "1M" },
];

// [SL-11] Flags with dedicated UI controls excluded from the options grid
const DEDICATED_FLAGS = new Set([
  "--model", "--permission-mode", "--effort",
  "--dangerously-skip-permissions", "--project-dir",
  "--resume", "--session-id", "--continue",
  "--system-prompt", "--append-system-prompt",
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
  const modelRegistry = useSettingsStore((s) => s.modelRegistry);
  const registryEntries = useMemo(() => Object.values(modelRegistry), [modelRegistry]);

  // When resuming, use session-specific settings from lastConfig (set by handleConfigure);
  // otherwise savedDefaults (explicit "Save defaults") takes priority over lastConfig
  const defaults = lastConfig.resumeSession ? lastConfig : (savedDefaults ?? lastConfig);
  const [config, setConfig] = useState<SessionConfig>({
    ...DEFAULT_SESSION_CONFIG,
    ...defaults,
    continueSession: false,
    sessionId: null,
    runMode: false,
  });
  const isUtilityRef = useRef(false);
  const mountedRef = useRef(false);
  const [showCliOptions, setShowCliOptions] = useState(true);
  const [showUtility, setShowUtility] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState<string>("");
  const [promptMode, setPromptMode] = useState<"replace" | "append">("replace");
  const [autoTap, setAutoTap] = useState(false);
  const [autoTraffic, setAutoTraffic] = useState(false);

  // Derive model family + context variant from config.model for the pill UI.
  // e.g. "claude-opus-4-6[1m]" → family="opus", variant="1m"
  // e.g. "sonnet" → family="sonnet", variant="200k"
  // e.g. null → family=null, variant="200k"
  const selectedModelFamily = extractModelFamily(config.model);
  const selectedContextVariant: "200k" | "1m" = isModel1m(config.model) ? "1m" : "200k";

  // Which families have confirmed 1M entries in the registry?
  const families1mAvailable = useMemo(() => {
    const set = new Set<string>();
    for (const entry of registryEntries) {
      if (entry.modelId.includes("[1m]")) set.add(entry.family);
    }
    return set;
  }, [registryEntries]);

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

  const handleModelFamilyChange = useCallback((family: string | null) => {
    if (!family) {
      updateConfig("model", null);
    } else {
      // When switching family, apply current context variant preference
      const currentVariant = isModel1m(config.model) ? "1m" : "200k";
      const entries = Object.values(useSettingsStore.getState().modelRegistry);
      updateConfig("model", resolveModelId(family, currentVariant, entries));
    }
  }, [config.model, updateConfig]);

  const handleContextVariantChange = useCallback((variant: "200k" | "1m" | null) => {
    const family = extractModelFamily(config.model);
    if (!family) return;
    const v = variant ?? "200k";
    const entries = Object.values(useSettingsStore.getState().modelRegistry);
    updateConfig("model", resolveModelId(family, v, entries));
  }, [config.model, updateConfig]);

  const handlePermChange = useCallback((value: PermissionMode | null) => {
    updateConfig("permissionMode", value ?? "default");
  }, [updateConfig]);

  const handleEffortChange = useCallback((value: string | null) => {
    updateConfig("effort", value);
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
      const session = await createSession(name, finalConfig);
      // Auto-start recording flags (consumed by TerminalPanel on spawn/connect)
      if (autoTap) useSessionStore.getState().startAllTaps(session.id);
      if (autoTraffic) useSessionStore.getState().setAutoTrafficLogOnStart(session.id);
      setShowLauncher(false);
    } catch (err) {
      dlog("launcher", null, `create session failed: ${err}`, "ERR");
    }
  }, [launchConfig, isNonSessionCommand, commandTokens, createSession, closeSession, setShowLauncher, addRecentDir, setLastConfig, autoTap]);

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

        {/* Pill selectors — inline, wrapping */}
        <div className={`launcher-pills-section${isNonSessionCommand ? " launcher-selects-disabled" : ""}`}>
          <span className="launcher-pill-icon" title="Model"><IconModelDiamond size={13} /></span>
          <PillGroup
            options={MODEL_PILLS}
            selected={selectedModelFamily}
            onChange={handleModelFamilyChange}
            colorFn={modelColorFn}
            disabled={isNonSessionCommand}
          />
          {selectedModelFamily && families1mAvailable.has(selectedModelFamily) && (
            <PillGroup
              options={CONTEXT_PILLS}
              selected={selectedContextVariant}
              onChange={handleContextVariantChange}
              className="launcher-context-pills"
              disabled={isNonSessionCommand}
            />
          )}
          <span className="launcher-pill-icon" title="Permissions"><IconLock size={13} /></span>
          <PillGroup
            options={PERM_PILLS}
            selected={config.permissionMode === "default" ? null : config.permissionMode}
            onChange={handlePermChange}
            disabled={isNonSessionCommand}
          />
          <span className="launcher-pill-icon" title="Effort"><IconLightning size={13} /></span>
          <PillGroup
            options={EFFORT_PILLS}
            selected={config.effort}
            onChange={handleEffortChange}
            disabled={isNonSessionCommand}
          />
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
          {savedPrompts.length > 0 && (
            <>
              <select
                className="launcher-select launcher-prompt-select"
                value={selectedPromptId}
                onChange={(e) => setSelectedPromptId(e.target.value)}
                disabled={isNonSessionCommand}
                title="System prompt"
              >
                <option value="">Default Prompt</option>
                {savedPrompts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
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
            </>
          )}
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
                className={`launcher-toggle-pill${autoTap ? " launcher-toggle-pill-on launcher-toggle-tap" : ""}`}
                onClick={() => setAutoTap((v) => !v)}
                aria-pressed={autoTap}
                title="Auto-start TAP recording on connect"
                type="button"
                disabled={isNonSessionCommand}
              >
                <IconAntenna size={12} /> TAP
              </button>
              <button
                className={`launcher-toggle-pill${autoTraffic ? " launcher-toggle-pill-on launcher-toggle-tfc" : ""}`}
                onClick={() => setAutoTraffic((v) => !v)}
                aria-pressed={autoTraffic}
                title="Auto-start API traffic logging from first request"
                type="button"
                disabled={isNonSessionCommand}
              >
                <IconTraffic size={12} /> TFC
              </button>
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
                  {sortedCliCommands.map((cmd) => {
                    const heatClass = heatClassName(computeHeatLevel(commandUsage[cmd.name] || 0, cliCommandMaxCount));
                    return (
                      <button
                        key={cmd.name}
                        className={`launcher-cli-pill launcher-cli-pill-cmd${heatClass ? ` ${heatClass}` : ""}`}
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
