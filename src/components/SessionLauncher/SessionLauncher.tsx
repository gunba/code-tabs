import { useState, useCallback, useEffect, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import type { CliOption } from "../../store/settings";
import { dirToTabName } from "../../lib/claude";
import {
  type SessionConfig,
  type PermissionMode,
  DEFAULT_SESSION_CONFIG,
} from "../../types/session";
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

// ── Main component ──────────────────────────────────────────────────

export function SessionLauncher() {
  const createSession = useSessionStore((s) => s.createSession);
  const claudePath = useSessionStore((s) => s.claudePath);
  const { recentDirs, lastConfig, setShowLauncher, addRecentDir, removeRecentDir, setLastConfig, setSavedDefaults } =
    useSettingsStore();
  const cliCapabilities = useSettingsStore((s) => s.cliCapabilities);

  const [config, setConfig] = useState<SessionConfig>({
    ...DEFAULT_SESSION_CONFIG,
    model: lastConfig.model,
    permissionMode: lastConfig.permissionMode,
    effort: lastConfig.effort,
    dangerouslySkipPermissions: lastConfig.dangerouslySkipPermissions,
    projectDir: lastConfig.projectDir,
    workingDir: lastConfig.workingDir || "",
    resumeSession: lastConfig.resumeSession,
  });
  const [showCliOptions, setShowCliOptions] = useState(true);
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

  const [commandLine, setCommandLine] = useState(() => buildFullCommand(config, lastConfig.extraFlags || ""));

  // Regenerate command line when config dropdowns change
  useEffect(() => {
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
      .sort((a, b) => a.flag.localeCompare(b.flag));
  }, [cliCapabilities.options]);

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
    if (!launchConfig.workingDir.trim()) return;
    const name = dirToTabName(launchConfig.workingDir);
    addRecentDir(launchConfig.workingDir);
    // Save config as defaults but strip one-shot resume fields —
    // these are per-launch, not persistent defaults.
    setLastConfig({ ...launchConfig, resumeSession: null, continueSession: false });
    try {
      // If relaunching an existing session, close it first
      const replaceId = useSettingsStore.getState().replaceSessionId;
      if (replaceId) {
        await closeSession(replaceId);
        useSettingsStore.getState().setReplaceSessionId(null);
      }
      await createSession(name, launchConfig);
      setShowLauncher(false);
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [launchConfig, createSession, closeSession, setShowLauncher, addRecentDir, setLastConfig]);

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

  const handleCliPillClick = useCallback(
    (opt: CliOption) => {
      const flag = opt.flag;
      const append = opt.argName ? ` ${flag} ` : ` ${flag}`;
      setCommandLine((prev) => {
        if (prev.includes(flag)) return prev;
        return prev + append;
      });
    },
    []
  );

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

  // ── Main launcher ──

  return (
    <div className="launcher-overlay" onClick={dismissLauncher}>
      <div className="launcher" onClick={(e) => e.stopPropagation()}>

        {/* Resume banner or path input */}
        {isResuming ? (
          <div className="launcher-resume-banner">
            <span className="launcher-resume-banner-icon">↩</span>
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
              📂
            </button>
          </div>
        )}

        {/* Recent directories — only for new sessions */}
        {!isResuming && uniqueRecentDirs.length > 0 && (
          <div className="launcher-recent">
            <div className="launcher-recent-chips">
              {uniqueRecentDirs.slice(0, 6).map((dir) => (
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
        <div className="launcher-selects">
          <label className="launcher-select-group">
            <span className="launcher-select-icon" title="Model">◈</span>
            <select
              className="launcher-select"
              value={config.model ?? ""}
              onChange={(e) => updateConfig("model", e.target.value || null)}
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={String(opt.value)} value={opt.value ?? ""}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="launcher-select-group">
            <span className="launcher-select-icon" title="Permissions">🔒</span>
            <select
              className="launcher-select"
              value={config.permissionMode}
              onChange={(e) => updateConfig("permissionMode", e.target.value as PermissionMode)}
            >
              {PERM_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="launcher-select-group">
            <span className="launcher-select-icon" title="Effort">⚡</span>
            <select
              className="launcher-select"
              value={config.effort ?? ""}
              onChange={(e) => updateConfig("effort", e.target.value || null)}
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
            {(filteredCliOptions.length > 0 || (cliCapabilities.commands || []).length > 0) ? (
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
              type="button"
            >
              {defaultsSaved ? "Saved" : "Save defaults"}
            </button>
          </div>
          {showCliOptions && filteredCliOptions.length > 0 && (
            <div className="launcher-cli-grid">
              {filteredCliOptions.map((opt) => (
                <button
                  key={opt.flag}
                  className="launcher-cli-pill"
                  onClick={() => handleCliPillClick(opt)}
                  title={opt.description}
                  type="button"
                >
                  {opt.flag}
                </button>
              ))}
            </div>
          )}
          {showCliOptions && (cliCapabilities.commands || []).length > 0 && (
            <div className="launcher-cli-grid" style={{ marginTop: 4 }}>
              {[...(cliCapabilities.commands || [])].sort((a, b) => a.name.localeCompare(b.name)).map((cmd) => (
                <button
                  key={cmd.name}
                  className="launcher-cli-pill launcher-cli-pill-cmd"
                  onClick={() => setCommandLine(prev => prev.trimEnd() + ` ${cmd.name}`)}
                  title={cmd.description}
                  type="button"
                >
                  {cmd.name}
                </button>
              ))}
            </div>
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
              ↺
            </button>
          </div>
        </div>

        {/* Launch button */}
        <button
          className="launcher-launch-btn"
          onClick={handleLaunch}
          disabled={!launchConfig.workingDir.trim()}
          type="button"
        >
          {isResuming ? "Resume" : "Launch"}
        </button>
      </div>
    </div>
  );
}
