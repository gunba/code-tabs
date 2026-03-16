import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { useSessionStore } from "../../store/sessions";
import { dirToTabName } from "../../lib/claude";
import "./ActivityFeed.css";

interface FeedEntry {
  id: string;
  timestamp: number;
  sessionName: string;
  type: "output" | "summary" | "name" | "system";
  message: string;
}

const MAX_ENTRIES = 300;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface PrevSession {
  state: string;
  summary: string | null;
  name: string;
  recentOutput: string;
  settled: boolean; // true after first idle transition from an active state (not initial state)
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
        // Initialize with CURRENT values so restored/revived state doesn't
        // generate spurious feed entries. Not settled until first active→idle transition.
        prev.set(session.id, {
          state: session.state,
          summary: session.metadata.nodeSummary ?? null,
          name: sessionName,
          recentOutput: session.metadata.recentOutput ?? "",
          settled: false,
        });
        continue;
      }

      // Expose tracking state for test harness
      (globalThis as Record<string, unknown>).__feedTracking = Object.fromEntries(
        Array.from(prev.entries()).map(([id, p]) => [id.slice(0, 8), { settled: p.settled, state: p.state }])
      );

      // Mark as settled once the session has been through a real response cycle.
      // A session coming from "starting" goes to "idle" — that's the PTY spawn, not a response.
      // Settle when we see a thinking/toolUse state (meaning Claude is actually processing).
      if (!existing.settled && (session.state === "thinking" || session.state === "toolUse")) {
        existing.settled = true;
      }

      // Agent output — what they're "typing" (speech bubble replacement)
      const currentOutput = session.metadata.recentOutput ?? "";
      if (currentOutput && currentOutput !== existing.recentOutput && session.state !== "dead") {
        // Only show in feed after the session has settled
        if (existing.settled) {
          const trimmed = currentOutput.trim().slice(0, 500);
          if (trimmed) {
            addEntry({ timestamp: now, sessionName, type: "output", message: trimmed });
          }
        }
        // Always track the latest value (even before settled) so we don't
        // flood when the session settles
        existing.recentOutput = currentOutput;
      }

      // Track state (for internal use) but don't spam the feed with transitions
      existing.state = session.state;

      // Summary update (from Haiku) — suppress until settled (revival/restore)
      const currentSummary = session.metadata.nodeSummary ?? null;
      if (currentSummary && currentSummary !== existing.summary) {
        if (existing.settled) {
          addEntry({ timestamp: now, sessionName, type: "summary", message: currentSummary });
        }
        existing.summary = currentSummary;
      }

      // Name change
      if (sessionName !== existing.name) {
        addEntry({ timestamp: now, sessionName, type: "name", message: `Renamed → ${sessionName}` });
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
              <span className="feed-nick">{entry.sessionName}</span>
              <span className="feed-msg"><ReactMarkdown>{entry.message}</ReactMarkdown></span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
