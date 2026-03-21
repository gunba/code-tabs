import { useCallback, useEffect, useRef, useState } from "react";
import "./DebugPanel.css";

interface DebugPanelProps {
  onClose: () => void;
}

function getConsoleLogs(): string[] | undefined {
  return (globalThis as Record<string, unknown>).__consoleLogs as string[] | undefined;
}

function logSeverityClass(line: string): string {
  if (line.includes("] [WARN]")) return "debug-line debug-line-warn";
  if (line.includes("] [ERR]")) return "debug-line debug-line-err";
  return "debug-line";
}

export function DebugPanel({ onClose }: DebugPanelProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevLenRef = useRef(0);

  // Poll globalThis.__consoleLogs every 500ms (skip if unchanged)
  useEffect(() => {
    const interval = setInterval(() => {
      const captured = getConsoleLogs();
      if (captured && captured.length !== prevLenRef.current) {
        setLogs([...captured]);
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll to bottom on new entries (only if already at bottom)
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

  const filtered = filter
    ? logs.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(filtered.join("\n"));
  }, [filtered]);

  const handleClear = useCallback(() => {
    const captured = getConsoleLogs();
    if (captured) captured.length = 0;
    setLogs([]);
  }, []);

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <span className="debug-panel-title">Debug Log</span>
        <span className="debug-panel-count">{filtered.length}</span>
        <button className="debug-panel-btn" onClick={handleCopy} title="Copy all visible logs">
          Copy
        </button>
        <button className="debug-panel-btn" onClick={handleClear} title="Clear all logs">
          Clear
        </button>
        <button className="debug-panel-close" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="debug-panel-filter">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs..."
        />
      </div>
      <div className="debug-panel-body" ref={scrollRef} onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <div className="debug-panel-empty">No log entries</div>
        ) : (
          filtered.map((line, i) => (
            <div key={i} className={logSeverityClass(line)}>{line}</div>
          ))
        )}
      </div>
    </div>
  );
}
