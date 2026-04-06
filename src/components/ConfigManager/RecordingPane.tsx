import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../store/settings";
import { useSessionStore } from "../../store/sessions";
import seedEventKinds from "../../types/eventKinds.json";
import type { StatusMessage } from "../../lib/settingsSchema";
import { TAP_CATEGORY_GROUPS } from "../../lib/tapCatalog";
import { useRuntimeStore } from "../../store/runtime";
import "./RecordingPane.css";

interface RecordingPaneProps {
  onStatus: (msg: StatusMessage | null) => void;
}

const seedSet = new Set(seedEventKinds as string[]);

export function RecordingPane({ onStatus }: RecordingPaneProps) {
  const recordingConfig = useSettingsStore((s) => s.recordingConfig);
  const setRecordingConfig = useSettingsStore((s) => s.setRecordingConfig);
  const toggleNoisyEventKind = useSettingsStore((s) => s.toggleNoisyEventKind);
  const seenEventKinds = useSessionStore((s) => s.seenEventKinds);
  const globalLogPath = useRuntimeStore((s) => s.observabilityInfo.globalLogPath);
  const [cleaning, setCleaning] = useState(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSeenCountRef = useRef(0);

  const noisySet = useMemo(
    () => new Set(recordingConfig.noisyEventKinds),
    [recordingConfig.noisyEventKinds],
  );

  // All known event kinds: seed file + runtime-discovered, sorted
  const allKinds = useMemo(() => {
    const combined = new Set(seedEventKinds as string[]);
    for (const k of seenEventKinds) combined.add(k);
    return [...combined].sort();
  }, [seenEventKinds]);

  // Debounced flush of newly discovered event kinds to disk
  useEffect(() => {
    if (seenEventKinds.size <= prevSeenCountRef.current) return;
    prevSeenCountRef.current = seenEventKinds.size;

    // Check if there are any kinds not in the seed file
    let hasNew = false;
    for (const k of seenEventKinds) {
      if (!seedSet.has(k)) { hasNew = true; break; }
    }
    if (!hasNew) return;

    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      const merged = [...new Set([...seedEventKinds as string[], ...seenEventKinds])].sort();
      invoke("save_event_kinds", {
        projectRoot: window.location.href.includes("localhost")
          ? import.meta.env.DEV ? "." : "."
          : ".",
        kinds: merged,
      }).catch(() => {});
      flushTimerRef.current = null;
    }, 5000);

    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [seenEventKinds]);

  const handleExport = useCallback(async () => {
    try {
      const merged = [...new Set([...seedEventKinds as string[], ...seenEventKinds])].sort();
      await invoke("save_event_kinds", { projectRoot: ".", kinds: merged });
      onStatus({ type: "success", text: `Exported ${merged.length} event kinds` });
    } catch (e) {
      onStatus({ type: "error", text: `Export failed: ${e}` });
    }
  }, [seenEventKinds, onStatus]);

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

  const setMaxAge = useCallback((hours: number) => {
    setRecordingConfig({ maxAgeHours: Math.max(1, hours) });
  }, [setRecordingConfig]);

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

  const openAppLog = useCallback(async () => {
    try {
      await invoke("open_observability_log", { sessionId: null });
    } catch {
      onStatus({ type: "error", text: "Could not open app observability log" });
    }
  }, [onStatus]);

  const discoveredCount = allKinds.filter((k) => !seedSet.has(k)).length;

  return (
    <div className="recording-pane">
      <div className="recording-section">
        <div className="recording-section-title">Debug Build Observability</div>
        <span className="recording-hint">
          This panel is only available in debug builds. Frontend and backend events are written to structured JSONL with ISO timestamps.
        </span>
        <div className="recording-data-row">
          <button className="recording-btn" onClick={openAppLog}>
            Open App Log
          </button>
          {globalLogPath && (
            <span className="recording-hint">{globalLogPath}</span>
          )}
        </div>
      </div>

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
          {TAP_CATEGORY_GROUPS.map((group) => (
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
                    <span className="recording-category-copy">
                      <span className="recording-category-label">{cat.label}</span>
                      <span className="recording-category-source">{cat.hookSource}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Event Filtering */}
      <div className="recording-section">
        <div className="recording-section-title">Event Filtering</div>
        <span className="recording-hint">
          Hide noisy events from debug panel and tab activity.
          Click to toggle. Struck-through events are filtered.
        </span>
        <div className="event-filter-pills">
          {allKinds.map((kind) => {
            const isNoisy = noisySet.has(kind);
            const isDiscovered = !seedSet.has(kind);
            return (
              <button
                key={kind}
                className={`event-filter-pill${isNoisy ? " active" : ""}${isDiscovered ? " discovered" : ""}`}
                onClick={() => toggleNoisyEventKind(kind)}
                title={isDiscovered ? `${kind} (discovered at runtime)` : kind}
              >
                {kind}
              </button>
            );
          })}
        </div>
        {discoveredCount > 0 && (
          <div className="event-filter-export-row">
            <button className="recording-btn" onClick={handleExport}>
              Export {discoveredCount} new kind{discoveredCount !== 1 ? "s" : ""}
            </button>
            <span className="recording-hint">Save to eventKinds.json</span>
          </div>
        )}
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

      {/* Debug Capture */}
      <div className="recording-section">
        <label className="recording-master-toggle">
          <input
            type="checkbox"
            checked={recordingConfig.debugCapture}
            onChange={() => setRecordingConfig({ debugCapture: !recordingConfig.debugCapture })}
          />
          <span className="recording-section-title">Verbose App Logs</span>
          <span className="recording-hint">Capture DEBUG-level frontend/backend observability entries</span>
        </label>
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
