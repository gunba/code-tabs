import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../store/settings";
import { useSessionStore } from "../../store/sessions";
import seedEventKinds from "../../types/eventKinds.json";
import type { StatusMessage } from "../../lib/settingsSchema";
import "./RecordingPane.css";

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

const seedSet = new Set(seedEventKinds as string[]);

export function RecordingPane({ onStatus }: RecordingPaneProps) {
  const recordingConfig = useSettingsStore((s) => s.recordingConfig);
  const setRecordingConfig = useSettingsStore((s) => s.setRecordingConfig);
  const toggleNoisyEventKind = useSettingsStore((s) => s.toggleNoisyEventKind);
  const seenEventKinds = useSessionStore((s) => s.seenEventKinds);
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

  const discoveredCount = allKinds.filter((k) => !seedSet.has(k)).length;

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
                    {/* [CM-27] Show the persisted TAP category key beside the friendly label. */}
                    <span className="recording-cat-key">{cat.key}</span>
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
