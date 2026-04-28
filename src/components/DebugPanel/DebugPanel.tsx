import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessions";
import { sessionColor } from "../../lib/claude";
import { dirToTabName } from "../../lib/paths";
// [DP-12] Strategic logging at key points: PTY spawn/kill/exit, TerminalPanel respawn, inspector connect/disconnect, tap pipeline, session lifecycle. All flow through dlog() and surface here via per-session ring buffers.
import { dlog, getDebugLog, getDebugLogForSession, subscribeDebugLog, clearDebugLog, type DebugLogEntry, type DebugLogSource } from "../../lib/debugLog";
import "./DebugPanel.css";

const MARKERS = [
  { id: 1, label: "1", color: "var(--accent)" },
  { id: 2, label: "2", color: "#e0a34a" },
  { id: 3, label: "3", color: "#d76c6c" },
  { id: 4, label: "4", color: "#6fbf8f" },
] as const;

const MAX_LOG_SNAPSHOT = 4000;
const MAX_RENDERED_ROWS = 1200;

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatData(data: unknown): string {
  if (data == null) return "";
  try {
    const json = JSON.stringify(data);
    return json === "{}" || json === "[]" ? "" : json;
  } catch {
    return "";
  }
}

function buildSearchText(entry: DebugLogEntry): string {
  const parts = [
    entry.tsIso,
    entry.level,
    entry.source,
    entry.module,
    entry.event,
    entry.message,
  ];
  const data = formatData(entry.data);
  if (data) parts.push(data);
  return parts.join(" ").toLowerCase();
}

// [DP-09] Color-coded by severity: LOG=default, WARN=warning, ERR=error
function levelClass(level: string): string {
  if (level === "WARN") return "debug-line debug-line-warn";
  if (level === "ERR") return "debug-line debug-line-err";
  if (level === "DEBUG") return "debug-line debug-line-debug";
  return "debug-line";
}

// [DP-01] Debug log view with session/module filters
export function DebugPanel() {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  // [DP-06] Free-text filter applied over module/event/message/data so users can grep the live buffer.
  const [textFilter, setTextFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState<string | "all" | "global">("all");
  const [moduleFilter, setModuleFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<DebugLogSource>>(new Set());
  const [levelFilter, setLevelFilter] = useState<Set<DebugLogEntry["level"]>>(new Set());
  const [showDebug, setShowDebug] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevLenRef = useRef(0);
  const markerCounterRef = useRef(0);
  const pendingRefreshRef = useRef(false);

  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);

  const hasActivePanelSelection = useCallback(() => {
    const panel = scrollRef.current;
    if (!panel) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    return (
      (sel.anchorNode != null && panel.contains(sel.anchorNode)) ||
      (sel.focusNode != null && panel.contains(sel.focusNode))
    );
  }, []);

  // [DP-05] Subscribe to debug-log generation changes instead of polling. Defer
  // refresh while the user has an active text selection in the panel.
  const refreshLogs = useCallback(() => {
    if (hasActivePanelSelection()) {
      pendingRefreshRef.current = true;
      return;
    }
    pendingRefreshRef.current = false;
    if (sessionFilter === "all") {
      setLogs(getDebugLog(MAX_LOG_SNAPSHOT));
    } else if (sessionFilter === "global") {
      setLogs([...getDebugLogForSession(null)].slice(-MAX_LOG_SNAPSHOT));
    } else {
      setLogs([...getDebugLogForSession(sessionFilter)].slice(-MAX_LOG_SNAPSHOT));
    }
  }, [hasActivePanelSelection, sessionFilter]);

  useEffect(() => {
    refreshLogs();
    return subscribeDebugLog(refreshLogs);
  }, [refreshLogs]);

  useEffect(() => {
    const handleSelectionChange = () => {
      if (!pendingRefreshRef.current || hasActivePanelSelection()) return;
      refreshLogs();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [hasActivePanelSelection, refreshLogs]);

  // [DP-07] Auto-scroll to bottom on new entries (pauses if user scrolls up)
  useEffect(() => {
    if (logs.length > prevLenRef.current && autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = logs.length;
  }, [logs.length]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 30;
  }, []);

  // Derive unique session IDs and modules from the buffer
  const { sessionIds, modules } = useMemo(() => {
    const sids = new Set<string>();
    const mods = new Set<string>();
    for (const e of logs) {
      if (e.sessionId) sids.add(e.sessionId);
      mods.add(e.module);
    }
    return { sessionIds: [...sids], modules: [...mods].sort() };
  }, [logs]);

  // Resolve session names for chips
  const sessionInfo = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const sid of sessionIds) {
      const s = sessions.find((x) => x.id === sid);
      const name = s?.name || (s?.config.workingDir ? dirToTabName(s.config.workingDir) : sid.slice(0, 8));
      map.set(sid, { name, color: sessionColor(sid) });
    }
    return map;
  }, [sessionIds, sessions]);

  const selectedSessionId = sessionFilter !== "all" && sessionFilter !== "global"
    ? sessionFilter
    : activeTabId;

  // Filtering pipeline
  const filtered = useMemo(() => {
    let result = logs;
    // DEBUG visibility
    if (!showDebug) {
      result = result.filter((e) => e.level !== "DEBUG");
    }
    // Session filter
    if (sessionFilter === "global") {
      result = result.filter((e) => e.sessionId === null);
    } else if (sessionFilter !== "all") {
      result = result.filter((e) => e.sessionId === sessionFilter);
    }
    // Module filter (empty = show all)
    if (moduleFilter.size > 0) {
      result = result.filter((e) => moduleFilter.has(e.module));
    }
    // Source filter (empty = show all)
    if (sourceFilter.size > 0) {
      result = result.filter((e) => sourceFilter.has(e.source));
    }
    // Level filter (empty = show all currently visible levels)
    if (levelFilter.size > 0) {
      result = result.filter((e) => levelFilter.has(e.level));
    }
    // Text search
    if (textFilter) {
      const lower = textFilter.toLowerCase();
      result = result.filter((e) => buildSearchText(e).includes(lower));
    }
    return result;
  }, [logs, sessionFilter, moduleFilter, sourceFilter, levelFilter, textFilter, showDebug]);

  const rendered = useMemo(
    () => filtered.length > MAX_RENDERED_ROWS ? filtered.slice(-MAX_RENDERED_ROWS) : filtered,
    [filtered],
  );

  // [DP-08] Copy joins all currently-visible (filtered) entries as one tsv-like string and pushes via navigator.clipboard.writeText; Clear empties the underlying ring buffer via clearDebugLog().
  const handleCopy = useCallback(() => {
    const text = filtered
      .map((e) => {
        const data = formatData(e.data);
        const suffix = data ? ` ${data}` : "";
        return `[${e.tsIso}] [${e.level}] [${e.source}] [${e.module}:${e.event}] ${e.message}${suffix}`;
      })
      .join("\n");
    navigator.clipboard.writeText(text);
  }, [filtered]);

  const handleClear = useCallback(() => {
    clearDebugLog();
    setLogs([]);
  }, []);

  const handleMarker = useCallback((markerId: number) => {
    markerCounterRef.current += 1;
    dlog("observability", selectedSessionId ?? null, `manual marker ${markerId}`, "LOG", {
      event: "debug.marker",
      data: {
        markerId,
        markerIndex: markerCounterRef.current,
        targetSessionId: selectedSessionId ?? null,
        sessionFilter,
      },
    });
  }, [selectedSessionId, sessionFilter]);

  const toggleModule = useCallback((mod: string) => {
    setModuleFilter((prev) => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
      return next;
    });
  }, []);

  const toggleSource = useCallback((source: DebugLogSource) => {
    setSourceFilter((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

  const toggleLevel = useCallback((level: DebugLogEntry["level"]) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <span className="debug-panel-title">Debug Log</span>
        <span className="debug-panel-count">{filtered.length}</span>
        <button
          className={`debug-panel-btn${showDebug ? " debug-panel-btn-active" : ""}`}
          onClick={() => setShowDebug((v) => !v)}
          title="Toggle verbose (DEBUG) entries"
        >
          Verbose
        </button>
        <button className="debug-panel-btn" onClick={handleCopy} title="Copy all visible logs">
          Copy
        </button>
        <button className="debug-panel-btn" onClick={handleClear} title="Clear all logs">
          Clear
        </button>
      </div>

      <div className="debug-panel-tools">
        <div className="debug-panel-markers" title="Add a manual timing marker to the debug log">
          {MARKERS.map((marker) => (
            <button
              key={marker.id}
              className="debug-marker-btn"
              style={{ ["--marker-color" as string]: marker.color }}
              onClick={() => handleMarker(marker.id)}
              title={`Add marker ${marker.id}`}
            >
              ⚑ {marker.label}
            </button>
          ))}
        </div>
      </div>

      {/* Session filter chips */}
      <div className="debug-panel-filters">
        <button
          className={`debug-filter-chip${sessionFilter === "all" ? " active" : ""}`}
          onClick={() => setSessionFilter("all")}
        >
          All
        </button>
        <button
          className={`debug-filter-chip${sessionFilter === "global" ? " active" : ""}`}
          onClick={() => setSessionFilter("global")}
        >
          Global
        </button>
        {activeTabId && sessionIds.includes(activeTabId) && (
          <button
            className={`debug-filter-chip${sessionFilter === activeTabId ? " active" : ""}`}
            onClick={() => setSessionFilter(sessionFilter === activeTabId ? "all" : activeTabId)}
          >
            <span className="chip-dot" style={{ background: sessionInfo.get(activeTabId)?.color }} />
            Active
          </button>
        )}
        {sessionIds
          .filter((sid) => sid !== activeTabId)
          .map((sid) => {
            const info = sessionInfo.get(sid);
            return (
              <button
                key={sid}
                className={`debug-filter-chip${sessionFilter === sid ? " active" : ""}`}
                onClick={() => setSessionFilter(sessionFilter === sid ? "all" : sid)}
                title={sid}
              >
                <span className="chip-dot" style={{ background: info?.color }} />
                <span className="chip-label">{info?.name}</span>
              </button>
            );
          })}
      </div>

      <div className="debug-panel-filters">
        {(["frontend", "backend"] as DebugLogSource[]).map((source) => (
          <button
            key={source}
            className={`debug-filter-chip${sourceFilter.has(source) ? " active" : ""}`}
            onClick={() => toggleSource(source)}
          >
            {source}
          </button>
        ))}
        {(["LOG", "WARN", "ERR", "DEBUG"] as DebugLogEntry["level"][]).map((level) => (
          <button
            key={level}
            className={`debug-filter-chip${levelFilter.has(level) ? " active" : ""}`}
            onClick={() => toggleLevel(level)}
          >
            {level}
          </button>
        ))}
      </div>

      {/* Module filter chips */}
      {modules.length > 0 && (
        <div className="debug-panel-filters">
          {modules.map((mod) => (
            <button
              key={mod}
              className={`debug-filter-chip debug-filter-chip-mod${moduleFilter.has(mod) ? " active" : ""}`}
              onClick={() => toggleModule(mod)}
            >
              {mod}
            </button>
          ))}
        </div>
      )}

      {/* Text filter */}
      <div className="debug-panel-filter">
        <input
          type="text"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="Filter logs..."
        />
      </div>

      {/* Log lines */}
      <div className="debug-panel-body" ref={scrollRef} onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <div className="debug-panel-empty">No log entries</div>
        ) : (
          <>
          {filtered.length > rendered.length && (
            <div className="debug-panel-truncated">
              Showing latest {rendered.length} of {filtered.length} matching entries
            </div>
          )}
          {rendered.map((entry) => {
            const borderColor = entry.sessionId
              ? (sessionInfo.get(entry.sessionId)?.color ?? sessionColor(entry.sessionId))
              : "var(--text-muted)";
            const data = formatData(entry.data);
            return (
              <div
                key={entry.id}
                className={levelClass(entry.level)}
                style={{ borderLeftColor: borderColor }}
                title={entry.tsIso}
              >
                <span className="debug-ts">{formatTs(entry.ts)}</span>
                <span className="debug-mod">[{entry.source}/{entry.module}:{entry.event}]</span>
                {" "}{entry.message}
                {data && (
                  <span className="debug-data"> {" "}{data}</span>
                )}
              </div>
            );
          })}
          </>
        )}
      </div>
    </div>
  );
}
