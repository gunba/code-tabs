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

const EXCLUDED_FLAGS = new Set<string>();

/** Build a CLI command preview string from the current config. */
function buildCommandPreview(config: SessionConfig): string {
  const parts: string[] = ["claude"];

  if (config.model) parts.push("--model", config.model);
  if (config.permissionMode !== "default") parts.push("--permission-mode", config.permissionMode);
  if (config.effort) parts.push("--effort", config.effort);
  if (config.dangerouslySkipPermissions) parts.push("--dangerously-skip-permissions");
  if (config.projectDir) parts.push("--project-dir", config.workingDir || ".");
  if (config.resumeSession) parts.push("--resume", config.resumeSession);

  return parts.join(" ");
}

// ── Main component ──────────────────────────────────────────────────

export function SessionLauncher() {
  const createSession = useSessionStore((s) => s.createSession);
  const claudePath = useSessionStore((s) => s.claudePath);
  const { recentDirs, lastConfig, setShowLauncher, addRecentDir, setLastConfig } =
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
  const [extraFlags, setExtraFlags] = useState(lastConfig.extraFlags || "");

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

  // Filter CLI options to only show non-excluded ones, sorted alphabetically
  const filteredCliOptions = useMemo((): CliOption[] => {
    return (cliCapabilities.options || [])
      .filter((opt) => !EXCLUDED_FLAGS.has(opt.flag))
      .sort((a, b) => a.flag.localeCompare(b.flag));
  }, [cliCapabilities.options]);

  // Merge extraFlags into config for launch
  const launchConfig = useMemo((): SessionConfig => {
    return { ...config, extraFlags: extraFlags.trim() || null };
  }, [config, extraFlags]);

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) handleLaunch();
      if (e.key === "Escape") {
        useSettingsStore.getState().setReplaceSessionId(null);
        // Clear one-shot resume state so the launcher isn't stuck in resume mode
        if (config.resumeSession) {
          setLastConfig({ ...lastConfig, resumeSession: null, continueSession: false });
        }
        setShowLauncher(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleLaunch, setShowLauncher]);

  const handleCliPillClick = useCallback(
    (opt: CliOption) => {
      const flag = opt.flag;
      const append = opt.argName ? `${flag} ` : `${flag} `;
      setExtraFlags((prev) => {
        if (prev.includes(flag)) return prev; // Already present
        return prev ? `${prev}${append}` : append;
      });
    },
    []
  );

  const commandPreview = useMemo(() => buildCommandPreview(launchConfig), [launchConfig]);

  // ── CLI not found ──

  if (!claudePath) {
    return (
      <div className="launcher-overlay" onClick={() => setShowLauncher(false)}>
        <div className="launcher" onClick={(e) => e.stopPropagation()}>
          <div className="launcher-error-content">
            <h2>Claude CLI Not Found</h2>
            <p className="launcher-error-msg">
              Claude Code must be installed to use Claude Tabs.
            </p>
            <p>
              Install it with: <code>npm install -g @anthropic-ai/claude-code</code>
            </p>
            <button className="btn-secondary launcher-error-close" onClick={() => setShowLauncher(false)}>
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
    <div className="launcher-overlay" onClick={() => { useSettingsStore.getState().setReplaceSessionId(null); if (config.resumeSession) setLastConfig({ ...lastConfig, resumeSession: null, continueSession: false }); setShowLauncher(false); }}>
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
          <>
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
          </>
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
                  title={dir}
                  type="button"
                >
                  {dirToTabName(dir)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Compact selects row: Model, Permissions, Effort, Skip checkbox, Save defaults */}
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

          <label className="launcher-skip-label" title="Restrict Claude to the working directory (--project-dir)">
            <input
              type="checkbox"
              checked={config.projectDir}
              onChange={(e) => updateConfig("projectDir", e.target.checked)}
            />
            <span className="launcher-skip-text">Sandbox</span>
          </label>

          <label className="launcher-skip-label" title="Skip all permission prompts (--dangerously-skip-permissions)">
            <input
              type="checkbox"
              checked={config.dangerouslySkipPermissions}
              onChange={(e) => updateConfig("dangerouslySkipPermissions", e.target.checked)}
            />
            <span className="launcher-skip-text">Skip</span>
          </label>

          <button
            className={`launcher-save-defaults${defaultsSaved ? " launcher-save-defaults-saved" : ""}`}
            onClick={() => { setLastConfig(launchConfig); setDefaultsSaved(true); setTimeout(() => setDefaultsSaved(false), 2000); }}
            type="button"
          >
            {defaultsSaved ? "Saved" : "Save defaults"}
          </button>
        </div>

        {/* CLI Options — collapsible */}
        {(filteredCliOptions.length > 0 || (cliCapabilities.commands || []).length > 0) && (
          <div className="launcher-section">
            <button
              className="launcher-cli-toggle"
              onClick={() => setShowCliOptions((v) => !v)}
              type="button"
            >
              {showCliOptions ? "\u25BE" : "\u25B8"} CLI Options
            </button>
            {showCliOptions && (
              <>
                {filteredCliOptions.length > 0 && (
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
                {/* CLI Subcommands */}
                {(cliCapabilities.commands || []).length > 0 && (
                  <div className="launcher-cli-grid" style={{ marginTop: 4 }}>
                    {[...(cliCapabilities.commands || [])].sort((a, b) => a.name.localeCompare(b.name)).map((cmd) => (
                      <button
                        key={cmd.name}
                        className="launcher-cli-pill launcher-cli-pill-cmd"
                        onClick={() => setExtraFlags(prev => {
                          const trimmed = prev.trim();
                          return trimmed ? `${trimmed} ${cmd.name}` : cmd.name;
                        })}
                        title={cmd.description}
                        type="button"
                      >
                        {cmd.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Command input — editable terminal-style prompt */}
        <div className="launcher-cmd">
          <div className="launcher-cmd-line">
            <span className="launcher-cmd-prefix">{commandPreview} </span>
            <textarea
              className="launcher-cmd-input"
              value={extraFlags}
              onChange={(e) => setExtraFlags(e.target.value)}
              placeholder=""
              spellCheck={false}
              rows={2}
            />
          </div>
        </div>

        {/* Enter hint */}
        <div className="launcher-enter-hint">
          <kbd>Enter</kbd>
        </div>
      </div>
    </div>
  );
}
