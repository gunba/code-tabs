import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { useSessionStore } from "../../store/sessions";
import { dirToTabName, sessionColor } from "../../lib/claude";
import "./ActivityFeed.css";

interface FeedEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  sessionName: string;
  type: "action" | "tool" | "name" | "system";
  message: string;
}

const MAX_ENTRIES = 300;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface PrevSession {
  state: string;
  name: string;
  currentAction: string | null;
  subagentActivity: string[];
  settled: boolean;
}

export function ActivityFeed() {
  const sessions = useSessionStore((s) => s.sessions);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<Map<string, PrevSession>>(new Map());

  const addEntry = useCallback((entry: Omit<FeedEntry, "id">) => {
    setEntries((prev) => {
      const next = [...prev, { ...entry, id: `${entry.timestamp}-${Math.random()}` }];
      // Expose for test harness
      (globalThis as Record<string, unknown>).__feedEntryCount = next.length;
      (globalThis as Record<string, unknown>).__feedLastEntry = entry;
      return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
    });
  }, []);

  // Track session changes and generate feed entries
  useEffect(() => {
    const prev = prevRef.current;
    const now = Date.now();

    for (const session of sessions) {
      if (session.isMetaAgent) continue;

      const sessionName = session.name || dirToTabName(session.config.workingDir);
      const existing = prev.get(session.id);

      if (!existing) {
        // Initialize with CURRENT values so restored/revived sessions don't
        // generate spurious entries (e.g. "Spawned 5 subagents" from historical count)
        prev.set(session.id, {
          state: session.state,
          name: sessionName,
          currentAction: session.metadata.currentAction ?? null,
          subagentActivity: [...(session.metadata.subagentActivity || [])],
          settled: session.metadata.assistantMessageCount > 0,
        });
        continue;
      }

      // Expose tracking state for test harness
      (globalThis as Record<string, unknown>).__feedTracking = Object.fromEntries(
        Array.from(prev.entries()).map(([id, p]) => [id.slice(0, 8), { settled: p.settled, state: p.state }])
      );

      // Mark as settled once the session has actual conversation data,
      // or transitions into an active state. Using assistantMessageCount
      // instead of observing a state transition avoids issues where React
      // batches rapid state changes and the feed never sees the intermediate.
      if (!existing.settled) {
        if (session.metadata.assistantMessageCount > 0) {
          existing.settled = true;
        } else if ((session.state === "thinking" || session.state === "toolUse") && existing.state !== session.state) {
          existing.settled = true;
        }
      }

      // State transitions — show meaningful changes
      if (session.state !== existing.state && existing.settled) {
        if (session.state === "idle" && (existing.state === "thinking" || existing.state === "toolUse")) {
          addEntry({ timestamp: now, sessionId: session.id, sessionName, type: "action", message: "Finished" });
        } else if (session.state === "thinking" && existing.state === "idle") {
          addEntry({ timestamp: now, sessionId: session.id, sessionName, type: "action", message: "Thinking..." });
        } else if (session.state === "waitingPermission") {
          addEntry({ timestamp: now, sessionId: session.id, sessionName, type: "action", message: "Waiting for permission" });
        } else if (session.state === "dead") {
          addEntry({ timestamp: now, sessionId: session.id, sessionName, type: "action", message: "Session ended" });
        }
      }

      // Tool use changes — show what tool is being used
      const currentAction = session.metadata.currentAction ?? null;
      if (currentAction && currentAction !== existing.currentAction && existing.settled) {
        addEntry({ timestamp: now, sessionId: session.id, sessionName, type: "tool", message: currentAction });
      }
      existing.currentAction = currentAction;

      // Subagent creation — show each new subagent individually
      const currentActivity = session.metadata.subagentActivity || [];
      if (currentActivity.length > existing.subagentActivity.length && existing.settled) {
        for (let i = existing.subagentActivity.length; i < currentActivity.length; i++) {
          addEntry({ timestamp: now, sessionId: session.id, sessionName, type: "action", message: `Subagent: ${currentActivity[i]}` });
        }
      }
      existing.subagentActivity = [...currentActivity];

      existing.state = session.state;

      // Name change
      if (sessionName !== existing.name) {
        addEntry({ timestamp: now, sessionId: session.id, sessionName, type: "name", message: `Renamed → ${sessionName}` });
        existing.name = sessionName;
      }
    }

    // Clean up tracking for removed sessions (no noise — revivals remove+recreate)
    for (const [id] of prev.entries()) {
      if (!sessions.find((s) => s.id === id)) {
        prev.delete(id);
      }
    }
  }, [sessions, addEntry]);

  // Auto-scroll on new entries
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  return (
    <div className="activity-feed">
      <div className="activity-feed-header">
        <span className="activity-feed-title">Activity</span>
        <span className="activity-feed-count">{entries.length}</span>
      </div>
      <div className="activity-feed-messages" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="activity-feed-empty">No activity yet</div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={`feed-entry feed-entry-${entry.type}`}>
              <span className="feed-time">{formatTime(entry.timestamp)}</span>
              <span className="feed-nick" style={{ color: sessionColor(entry.sessionId) }}>{entry.sessionName}</span>
              <span className="feed-msg"><ReactMarkdown>{entry.message}</ReactMarkdown></span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
