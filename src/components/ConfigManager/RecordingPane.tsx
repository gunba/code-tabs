import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../store/settings";
import { RECORDING_HOOK_EVENTS, auditGlobalHooks, installGlobalHooks } from "../../lib/globalHooks";
import type { StatusMessage } from "../../lib/settingsSchema";

interface RecordingPaneProps {
  onStatus: (msg: StatusMessage | null) => void;
}

interface CategoryGroup {
  label: string;
  categories: { key: string; label: string; locked?: boolean }[];
}

const CATEGORY_GROUPS: CategoryGroup[] = [
  {
    label: "Core (always on)",
    categories: [
      { key: "parse", label: "JSON.parse (SSE)", locked: true },
      { key: "stringify", label: "JSON.stringify (requests)", locked: true },
    ],
  },
  {
    label: "Process I/O",
    categories: [
      { key: "console", label: "console.*" },
      { key: "stdout", label: "stdout" },
      { key: "stderr", label: "stderr" },
    ],
  },
  {
    label: "File System",
    categories: [
      { key: "fs", label: "fs (sync)" },
      { key: "fspromises", label: "fs.promises (async)" },
      { key: "bunfile", label: "Bun.file()" },
      { key: "fswatch", label: "fs.watch" },
    ],
  },
  {
    label: "Network",
    categories: [
      { key: "fetch", label: "fetch" },
      { key: "websocket", label: "WebSocket" },
      { key: "net", label: "TCP/TLS" },
      { key: "stream", label: "stream.pipe" },
      { key: "textdecoder", label: "TextDecoder (SSE)" },
      { key: "abort", label: "AbortController" },
    ],
  },
  {
    label: "Process Lifecycle",
    categories: [
      { key: "spawn", label: "child_process" },
      { key: "exit", label: "process.exit" },
      { key: "timer", label: "setTimeout" },
      { key: "require", label: "require" },
      { key: "bun", label: "Bun.*" },
    ],
  },
  {
    label: "Internals",
    categories: [
      { key: "events", label: "EventEmitter" },
      { key: "envproxy", label: "process.env" },
    ],
  },
];

type HooksMap = Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;

export function RecordingPane({ onStatus }: RecordingPaneProps) {
  const recordingConfig = useSettingsStore((s) => s.recordingConfig);
  const setRecordingConfig = useSettingsStore((s) => s.setRecordingConfig);
  const [cleaning, setCleaning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [missingHooks, setMissingHooks] = useState<string[]>([]);

  // Check which hooks are installed
  useEffect(() => {
    invoke<Record<string, unknown>>("discover_hooks", { workingDirs: [] })
      .then((result) => {
        const userHooks = (result["user"] as HooksMap) ?? {};
        setMissingHooks(auditGlobalHooks(userHooks));
      })
      .catch(() => setMissingHooks([...RECORDING_HOOK_EVENTS]));
  }, [installing]);

  const toggleTapEnabled = useCallback(() => {
    setRecordingConfig({
      taps: { ...recordingConfig.taps, enabled: !recordingConfig.taps.enabled },
    });
  }, [recordingConfig.taps, setRecordingConfig]);

  const toggleCategory = useCallback((key: string) => {
    setRecordingConfig({
      taps: {
        ...recordingConfig.taps,
        categories: {
          ...recordingConfig.taps.categories,
          [key]: !recordingConfig.taps.categories[key],
        },
      },
    });
  }, [recordingConfig.taps, setRecordingConfig]);

  const toggleTraffic = useCallback(() => {
    setRecordingConfig({
      traffic: { enabled: !recordingConfig.traffic.enabled },
    });
  }, [recordingConfig.traffic, setRecordingConfig]);

  const toggleGlobalHooks = useCallback(() => {
    setRecordingConfig({
      globalHooks: { enabled: !recordingConfig.globalHooks.enabled },
    });
  }, [recordingConfig.globalHooks, setRecordingConfig]);

  const setMaxAge = useCallback((hours: number) => {
    setRecordingConfig({ maxAgeHours: Math.max(1, hours) });
  }, [setRecordingConfig]);

  const handleInstallHooks = useCallback(async () => {
    setInstalling(true);
    try {
      const result = await installGlobalHooks();
      onStatus({
        type: "success",
        text: result.installed > 0
          ? `Installed ${result.installed} recording hooks`
          : "All recording hooks already installed",
      });
    } catch (e) {
      onStatus({ type: "error", text: `Hook install failed: ${e}` });
    } finally {
      setInstalling(false);
    }
  }, [onStatus]);

  const handleCleanup = useCallback(async () => {
    setCleaning(true);
    try {
      const removed = await invoke<number>("cleanup_session_data", {
        maxAgeHours: recordingConfig.maxAgeHours,
      });
      onStatus({ type: "success", text: `Cleaned ${removed} session${removed !== 1 ? "s" : ""}` });
    } catch (e) {
      onStatus({ type: "error", text: `Cleanup failed: ${e}` });
    } finally {
      setCleaning(false);
    }
  }, [recordingConfig.maxAgeHours, onStatus]);

  const openDataDir = useCallback(async () => {
    try {
      const path = await invoke<string>("get_session_data_path", { sessionId: "__root__" });
      const parent = path.replace(/[/\\]__root__[/\\]?$/, "");
      await invoke("shell_open", { path: parent });
    } catch {
      onStatus({ type: "error", text: "Could not open data directory" });
    }
  }, [onStatus]);

  const installedCount = RECORDING_HOOK_EVENTS.length - missingHooks.length;

  return (
    <div className="recording-pane">
      {/* TAP Recording */}
      <div className="recording-section">
        <label className="recording-master-toggle">
          <input
            type="checkbox"
            checked={recordingConfig.taps.enabled}
            onChange={toggleTapEnabled}
          />
          <span className="recording-section-title">TAP Recording</span>
          <span className="recording-hint">Write intercepted events to disk</span>
        </label>

        <div className={`recording-categories${!recordingConfig.taps.enabled ? " recording-disabled" : ""}`}>
          {CATEGORY_GROUPS.map((group) => (
            <div key={group.label} className="recording-group">
              <div className="recording-group-label">{group.label}</div>
              <div className="recording-group-items">
                {group.categories.map((cat) => (
                  <label key={cat.key} className="recording-category">
                    <input
                      type="checkbox"
                      checked={cat.locked || !!recordingConfig.taps.categories[cat.key]}
                      onChange={() => !cat.locked && toggleCategory(cat.key)}
                      disabled={cat.locked || !recordingConfig.taps.enabled}
                    />
                    <span>{cat.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Traffic Logging */}
      <div className="recording-section">
        <label className="recording-master-toggle">
          <input
            type="checkbox"
            checked={recordingConfig.traffic.enabled}
            onChange={toggleTraffic}
          />
          <span className="recording-section-title">Traffic Logging</span>
          <span className="recording-hint">Log API request/response via proxy</span>
        </label>
      </div>

      {/* Global Hooks */}
      <div className="recording-section">
        <label className="recording-master-toggle">
          <input
            type="checkbox"
            checked={recordingConfig.globalHooks.enabled}
            onChange={toggleGlobalHooks}
          />
          <span className="recording-section-title">Global Hooks</span>
          <span className="recording-hint">Register no-op hooks to capture Claude Code events</span>
        </label>

        <div className="recording-hooks-status">
          <span className="recording-hooks-count">
            {installedCount}/{RECORDING_HOOK_EVENTS.length} hooks installed
          </span>
          {missingHooks.length > 0 && (
            <button
              className="recording-btn"
              onClick={handleInstallHooks}
              disabled={installing}
            >
              {installing ? "Installing..." : `Install ${missingHooks.length} Missing`}
            </button>
          )}
        </div>

        {missingHooks.length > 0 && (
          <div className="recording-hooks-missing">
            Missing: {missingHooks.join(", ")}
          </div>
        )}
      </div>

      {/* Data Management */}
      <div className="recording-section">
        <div className="recording-section-title">Data Management</div>
        <div className="recording-data-row">
          <label className="recording-age-label">
            Max age:
            <input
              type="number"
              className="recording-age-input"
              value={recordingConfig.maxAgeHours}
              onChange={(e) => setMaxAge(parseInt(e.target.value) || 72)}
              min={1}
            />
            hours
          </label>
          <button
            className="recording-btn"
            onClick={handleCleanup}
            disabled={cleaning}
          >
            {cleaning ? "Cleaning..." : "Clean Now"}
          </button>
          <button
            className="recording-btn"
            onClick={openDataDir}
          >
            Open Data Dir
          </button>
        </div>
      </div>
    </div>
  );
}
