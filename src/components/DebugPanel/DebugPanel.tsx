import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessions";
import { sessionColor } from "../../lib/claude";
import { dirToTabName } from "../../lib/paths";
import { getDebugLog, clearDebugLog, type DebugLogEntry } from "../../lib/debugLog";
import { IconClose } from "../Icons/Icons";
import "./DebugPanel.css";

interface DebugPanelProps {
  onClose: () => void;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

// [DP-09] Color-coded by severity: LOG=default, WARN=warning, ERR=error
function levelClass(level: string): string {
  if (level === "WARN") return "debug-line debug-line-warn";
  if (level === "ERR") return "debug-line debug-line-err";
  if (level === "DEBUG") return "debug-line debug-line-debug";
  return "debug-line";
}

// [DP-01] Collapsible right-side panel (350px) with session/module filters
export function DebugPanel({ onClose }: DebugPanelProps) {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [textFilter, setTextFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState<string | "all" | "global">("all");
  const [moduleFilter, setModuleFilter] = useState<Set<string>>(new Set());
  const [showDebug, setShowDebug] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevLenRef = useRef(0);

  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);

  // [DP-05] Poll getDebugLog() every 500ms
  useEffect(() => {
    const interval = setInterval(() => {
      const buf = getDebugLog();
      if (buf.length !== prevLenRef.current) {
        setLogs([...buf]);
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

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
    // Text search
    if (textFilter) {
      const lower = textFilter.toLowerCase();
      result = result.filter(
        (e) => e.message.toLowerCase().includes(lower) || e.module.toLowerCase().includes(lower),
      );
    }
    return result;
  }, [logs, sessionFilter, moduleFilter, textFilter, showDebug]);

  const handleCopy = useCallback(() => {
    const text = filtered
      .map((e) => `[${formatTs(e.ts)}] [${e.level}] [${e.module}] ${e.message}`)
      .join("\n");
    navigator.clipboard.writeText(text);
  }, [filtered]);

  const handleClear = useCallback(() => {
    clearDebugLog();
    setLogs([]);
  }, []);

  const toggleModule = useCallback((mod: string) => {
    setModuleFilter((prev) => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
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
        <button className="debug-panel-close" onClick={onClose} title="Close (Esc)">
          <IconClose size={14} />
        </button>
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
          filtered.map((entry, i) => {
            const borderColor = entry.sessionId
              ? (sessionInfo.get(entry.sessionId)?.color ?? sessionColor(entry.sessionId))
              : "var(--text-muted)";
            return (
              <div
                key={i}
                className={levelClass(entry.level)}
                style={{ borderLeftColor: borderColor }}
              >
                <span className="debug-ts">{formatTs(entry.ts)}</span>
                <span className="debug-mod">[{entry.module}]</span>
                {" "}{entry.message}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
