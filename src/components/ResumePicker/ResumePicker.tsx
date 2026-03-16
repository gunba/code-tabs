import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { dirToTabName } from "../../lib/claude";
import {
  type PastSession,
  type SessionConfig,
  DEFAULT_SESSION_CONFIG,
} from "../../types/session";
import "./ResumePicker.css";

// ── Helpers ─────────────────────────────────────────────────────────

function abbreviatePath(dir: string): string {
  const normalized = dir.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `~/${parts.slice(-2).join("/")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatRelativeDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Props ───────────────────────────────────────────────────────────

interface ResumePickerProps {
  onClose: () => void;
}

// ── Component ───────────────────────────────────────────────────────

export function ResumePicker({ onClose }: ResumePickerProps) {
  const createSession = useSessionStore((s) => s.createSession);
  const storeSessions = useSessionStore((s) => s.sessions);
  const { lastConfig, addRecentDir, setShowLauncher, setLastConfig } = useSettingsStore();

  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);
  const [dirFilter, setDirFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  // Load past sessions on mount
  useEffect(() => {
    invoke<PastSession[]>("list_past_sessions")
      .then((sessions) => setPastSessions(sessions))
      .catch(() => {});
    filterRef.current?.focus();
  }, []);

  // Dead session map: CLI session ID -> { nodeSummary, model, permissionMode, effort }
  const deadSessionMap = useMemo(() => {
    const map = new Map<string, {
      nodeSummary: string | null;
      config: SessionConfig;
    }>();
    for (const s of storeSessions) {
      if (s.state === "dead") {
        const key = s.config.sessionId || s.id;
        map.set(key, {
          nodeSummary: s.metadata.nodeSummary ?? null,
          config: s.config,
        });
      }
    }
    return map;
  }, [storeSessions]);

  // Filter past sessions by directory
  const filteredPastSessions = useMemo(() => {
    // Only show sessions that have actual content (summary, first message, or known dead session)
    let list = pastSessions.filter((ps) => {
      if (deadSessionMap.has(ps.id)) return true;
      if (ps.firstMessage && !ps.firstMessage.startsWith('Summarize: [{"')) return true;
      return false;
    });
    if (dirFilter.trim()) {
      // Normalize both sides by collapsing all non-alphanumeric chars to hyphens.
      // This handles the lossy decode_project_dir encoding where periods, spaces,
      // and path separators all become hyphens (e.g. "Jordan.Graham" encodes as
      // "Jordan-Graham" but decodes as "Jordan/Graham").
      const normalize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      const filterNorm = normalize(dirFilter);
      list = list.filter((ps) => {
        const dirNorm = normalize(ps.directory);
        return dirNorm.includes(filterNorm) || filterNorm.includes(dirNorm);
      });
    }
    return list;
  }, [pastSessions, dirFilter, deadSessionMap]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [dirFilter]);

  // Resume a past session directly
  const handleResume = useCallback(
    async (pastSession: PastSession) => {
      const workingDir = pastSession.directory || ".";
      const dead = deadSessionMap.get(pastSession.id);
      // Use the full original config if we have a dead tab, otherwise use defaults.
      // Don't spread lastConfig — it can contain stale flags like --effort that
      // Claude CLI may not support with --resume.
      const baseConfig = dead?.config ?? DEFAULT_SESSION_CONFIG;
      const resumeConfig: SessionConfig = {
        ...baseConfig,
        workingDir,
        resumeSession: pastSession.id,
        continueSession: false,
      };
      addRecentDir(workingDir);
      try {
        await createSession(pastSession.path, resumeConfig);
        onClose();
      } catch (err) {
        console.error("Failed to resume session:", err);
      }
    },
    [deadSessionMap, lastConfig, createSession, addRecentDir, onClose]
  );

  // Open the main launcher with this session pre-filled (Shift+Click / Configure)
  const handleConfigure = useCallback(
    (pastSession: PastSession) => {
      const dead = deadSessionMap.get(pastSession.id);
      const baseConfig = dead?.config ?? DEFAULT_SESSION_CONFIG;
      const prefillConfig: SessionConfig = {
        ...baseConfig,
        workingDir: pastSession.directory,
        resumeSession: pastSession.id,
        continueSession: false,
      };
      setLastConfig(prefillConfig);
      onClose();
      setShowLauncher(true);
    },
    [deadSessionMap, lastConfig, setLastConfig, onClose, setShowLauncher]
  );

  const handleBrowseFilter = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Filter by directory",
      defaultPath: dirFilter || undefined,
    });
    if (selected) setDirFilter(selected);
  }, [dirFilter]);

  // Keyboard: Enter resumes first visible, Escape closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Enter" && filteredPastSessions.length > 0) {
        e.preventDefault();
        const target = filteredPastSessions[selectedIndex] ?? filteredPastSessions[0];
        if (e.shiftKey) {
          handleConfigure(target);
        } else {
          handleResume(target);
        }
        return;
      }
      if (e.key === "ArrowDown" && filteredPastSessions.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredPastSessions.length - 1));
      }
      if (e.key === "ArrowUp" && filteredPastSessions.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, filteredPastSessions, selectedIndex, handleResume, handleConfigure]);

  return (
    <div className="resume-picker-overlay" onClick={onClose}>
      <div className="resume-picker" onClick={(e) => e.stopPropagation()}>
        <div className="resume-picker-title">Resume Session</div>

        {/* Filter row */}
        <div className="resume-picker-filter-row">
          <input
            ref={filterRef}
            className="resume-picker-filter"
            type="text"
            value={dirFilter}
            onChange={(e) => setDirFilter(e.target.value)}
            placeholder="Filter by directory..."
            autoComplete="off"
          />
          <button
            className="resume-picker-browse"
            onClick={handleBrowseFilter}
            title="Browse"
            type="button"
          >
            📂
          </button>
        </div>

        {/* Session list */}
        <div className="resume-picker-list">
          {filteredPastSessions.length === 0 && (
            <div className="resume-picker-empty">
              {pastSessions.length === 0 ? "No past sessions found" : "No sessions match filter"}
            </div>
          )}
          {filteredPastSessions.map((ps, idx) => {
            const dead = deadSessionMap.get(ps.id);
            const isSelected = idx === selectedIndex;
            return (
              <div
                key={ps.id}
                className={`resume-picker-card${isSelected ? " resume-picker-card-selected" : ""}`}
                onClick={(e) => {
                  if (e.shiftKey) {
                    handleConfigure(ps);
                  } else {
                    handleResume(ps);
                  }
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                title={`${ps.directory}\nSession: ${ps.id}\nShift+Click to configure`}
              >
                <div className="resume-picker-card-top">
                  <span className="resume-picker-card-name">
                    {dirToTabName(ps.directory)}
                  </span>
                  <span className="resume-picker-card-date">
                    {formatRelativeDate(ps.lastModified)}
                  </span>
                </div>
                <div className="resume-picker-card-mid">
                  <span className="resume-picker-card-dir">
                    {abbreviatePath(ps.directory)}
                  </span>
                  <span className="resume-picker-card-size">
                    {formatSize(ps.sizeBytes)}
                  </span>
                </div>
                <div className="resume-picker-card-bottom">
                  {dead?.nodeSummary ? (
                    <span className="resume-picker-card-summary-haiku">
                      {dead.nodeSummary}
                    </span>
                  ) : ps.firstMessage ? (
                    <span className="resume-picker-card-first-msg">
                      {ps.firstMessage}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* Hint */}
        <div className="resume-picker-hint">
          <kbd>↵</kbd> to resume &middot; <kbd>Shift+↵</kbd> to configure
        </div>
      </div>
    </div>
  );
}
