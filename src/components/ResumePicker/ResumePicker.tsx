import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { getResumeId, modelLabel } from "../../lib/claude";
import { dirToTabName, abbreviatePath, normalizeForFilter } from "../../lib/paths";
import { useCtrlKey } from "../../hooks/useCtrlKey";
import {
  type PastSession,
  type SessionConfig,
  DEFAULT_SESSION_CONFIG,
} from "../../types/session";
import "./ResumePicker.css";

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

/** Short model badge text from full model string */
function shortModelBadge(model: string): string | null {
  if (!model) return null;
  const label = modelLabel(model);
  if (label === model) return null; // Unknown model, skip badge
  // Extract version number if present (e.g. "claude-sonnet-4-5" → "4.5")
  const verMatch = model.match(/(\d+)[.-](\d+)/);
  const ver = verMatch ? ` ${verMatch[1]}.${verMatch[2]}` : "";
  // Drop minor ".0" for cleaner display
  return (label + ver).replace(/\.0$/, "");
}

// ── Chain grouping types ─────────────────────────────────────────

/** Flatten chain groups into a display list with indent metadata */
interface FlatEntry {
  session: PastSession;
  isChild: boolean;
  isExpander?: boolean;
  hiddenCount?: number;
  chainRootId?: string;
}

const MAX_VISIBLE_CHILDREN = 3;

// ── Props ───────────────────────────────────────────────────────────

interface ResumePickerProps {
  onClose: () => void;
}

// ── Component ───────────────────────────────────────────────────────

export function ResumePicker({ onClose }: ResumePickerProps) {
  const ctrlHeld = useCtrlKey();
  const createSession = useSessionStore((s) => s.createSession);
  const storeSessions = useSessionStore((s) => s.sessions);
  const activeSession = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeTabId));
  const activeIsDead = activeSession?.state === "dead";
  const requestRespawn = useSessionStore((s) => s.requestRespawn);
  const { addRecentDir, setShowLauncher, setLastConfig } = useSettingsStore();

  const pastSessions = useSettingsStore((s) => s.pastSessions);
  const pastSessionsLoading = useSettingsStore((s) => s.pastSessionsLoading);
  const loadPastSessions = useSettingsStore((s) => s.loadPastSessions);
  const sessionNames = useSettingsStore((s) => s.sessionNames);
  const sessionConfigs = useSettingsStore((s) => s.sessionConfigs);
  const [dirFilter, setDirFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Refresh past sessions on mount (background, non-blocking — data may already be preloaded)
  useEffect(() => {
    loadPastSessions();
    filterRef.current?.focus();
  }, [loadPastSessions]);

  // Dead session map: CLI session ID -> { appSessionId, nodeSummary, config }
  const deadSessionMap = useMemo(() => {
    const map = new Map<string, {
      appSessionId: string;
      nodeSummary: string | null;
      config: SessionConfig;
    }>();
    for (const s of storeSessions) {
      if (s.state === "dead") {
        const key = s.config.sessionId || s.id;
        const resumeKey = getResumeId(s);
        const entry = {
          appSessionId: s.id,
          nodeSummary: s.metadata.nodeSummary ?? null,
          config: s.config,
        };
        map.set(key, entry);
        if (resumeKey !== key) map.set(resumeKey, entry);
      }
    }
    return map;
  }, [storeSessions]);

  // Filter past sessions by directory
  const filteredPastSessions = useMemo(() => {
    let list = pastSessions.filter((ps) => {
      if (deadSessionMap.has(ps.id)) return true;
      if (ps.firstMessage && !ps.firstMessage.startsWith('Summarize: [{"')) return true;
      return false;
    });
    if (dirFilter.trim()) {
      const filterNorm = normalizeForFilter(dirFilter);
      list = list.filter((ps) => {
        const dirNorm = normalizeForFilter(ps.directory);
        return dirNorm.includes(filterNorm) || filterNorm.includes(dirNorm);
      });
    }
    return list;
  }, [pastSessions, dirFilter, deadSessionMap]);

  // Group sessions into chains by parentId
  const flatList = useMemo((): FlatEntry[] => {
    const childrenOf = new Map<string, PastSession[]>();
    const childIds = new Set<string>();

    // Build parent → children map (only if parent is in the filtered list)
    const filteredIds = new Set(filteredPastSessions.map((ps) => ps.id));
    for (const ps of filteredPastSessions) {
      if (ps.parentId && filteredIds.has(ps.parentId)) {
        childIds.add(ps.id);
        const siblings = childrenOf.get(ps.parentId) || [];
        siblings.push(ps);
        childrenOf.set(ps.parentId, siblings);
      }
    }

    const entries: FlatEntry[] = [];
    for (const ps of filteredPastSessions) {
      // Skip children — they'll be rendered under their parent
      if (childIds.has(ps.id)) continue;

      entries.push({ session: ps, isChild: false });

      const children = childrenOf.get(ps.id);
      if (children && children.length > 0) {
        const isExpanded = expandedChains.has(ps.id);
        const visible = isExpanded ? children : children.slice(0, MAX_VISIBLE_CHILDREN);
        for (const child of visible) {
          entries.push({ session: child, isChild: true });
        }
        if (!isExpanded && children.length > MAX_VISIBLE_CHILDREN) {
          entries.push({
            session: children[0], // placeholder
            isChild: true,
            isExpander: true,
            hiddenCount: children.length - MAX_VISIBLE_CHILDREN,
            chainRootId: ps.id,
          });
        }
      }
    }
    return entries;
  }, [filteredPastSessions, expandedChains]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [dirFilter]);

  // Scroll selected card into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const cards = container.querySelectorAll(".resume-picker-card, .resume-picker-expander");
    const card = cards[selectedIndex] as HTMLElement | undefined;
    card?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Resume a past session — reuse active dead tab if available, with config fallback
  const handleResume = useCallback(
    async (pastSession: PastSession) => {
      const workingDir = pastSession.directory || ".";
      const dead = deadSessionMap.get(pastSession.id);
      const cached = sessionConfigs[pastSession.id];
      // Use dead tab config, then cached config, then defaults
      const baseConfig = dead?.config ?? { ...DEFAULT_SESSION_CONFIG, ...cached };
      const resumeConfig: SessionConfig = {
        ...baseConfig,
        workingDir,
        resumeSession: pastSession.id,
        continueSession: false,
      };
      addRecentDir(workingDir);

      if (activeIsDead && activeSession) {
        requestRespawn(activeSession.id, resumeConfig, pastSession.path);
        onClose();
        return;
      }

      try {
        await createSession(pastSession.path, resumeConfig);
        onClose();
      } catch (err) {
        console.error("Failed to resume session:", err);
      }
    },
    [deadSessionMap, sessionConfigs, activeIsDead, activeSession, createSession, addRecentDir, requestRespawn, onClose]
  );

  // Open the main launcher with this session pre-filled (Ctrl+Click / Configure)
  const handleConfigure = useCallback(
    (pastSession: PastSession) => {
      const dead = deadSessionMap.get(pastSession.id);
      const cached = sessionConfigs[pastSession.id];
      const baseConfig = dead?.config ?? { ...DEFAULT_SESSION_CONFIG, ...cached };
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
    [deadSessionMap, sessionConfigs, setLastConfig, onClose, setShowLauncher]
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

  // Keyboard: Enter resumes, Escape closes, arrows navigate
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Enter" && flatList.length > 0) {
        e.preventDefault();
        const entry = flatList[selectedIndex] ?? flatList[0];
        if (entry.isExpander && entry.chainRootId) {
          setExpandedChains((s) => new Set(s).add(entry.chainRootId!));
          return;
        }
        if (e.ctrlKey) {
          handleConfigure(entry.session);
        } else {
          handleResume(entry.session);
        }
        return;
      }
      if (e.key === "ArrowDown" && flatList.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatList.length - 1));
      }
      if (e.key === "ArrowUp" && flatList.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, flatList, selectedIndex, handleResume, handleConfigure]);

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
        <div className="resume-picker-list" ref={listRef}>
          {flatList.length === 0 && (
            <div className="resume-picker-empty">
              {pastSessionsLoading
                ? "Loading sessions..."
                : pastSessions.length === 0
                  ? "No past sessions found"
                  : "No sessions match filter"}
            </div>
          )}
          {flatList.map((entry, idx) => {
            if (entry.isExpander) {
              return (
                <div
                  key={`expander-${entry.chainRootId}`}
                  className={`resume-picker-expander${idx === selectedIndex ? " resume-picker-expander-selected" : ""}`}
                  onClick={() => entry.chainRootId && setExpandedChains((s) => new Set(s).add(entry.chainRootId!))}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  +{entry.hiddenCount} more in chain...
                </div>
              );
            }

            const ps = entry.session;
            const dead = deadSessionMap.get(ps.id);
            const isSelected = idx === selectedIndex;
            const customName = sessionNames[ps.id];
            const badge = shortModelBadge(ps.model);
            const cardClass = [
              "resume-picker-card",
              isSelected && "resume-picker-card-selected",
              entry.isChild && "resume-picker-card-child",
            ].filter(Boolean).join(" ");

            return (
              <div
                key={ps.id}
                className={cardClass}
                onClick={(e) => {
                  if (e.ctrlKey) {
                    handleConfigure(ps);
                  } else {
                    handleResume(ps);
                  }
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                title={ctrlHeld
                  ? `Ctrl+Click: Configure & relaunch\n${ps.directory}`
                  : `${ps.directory}\nSession: ${ps.id}\nCtrl+Click to configure`}
              >
                <div className="resume-picker-card-top">
                  <span className="resume-picker-card-name">
                    {customName ? (
                      <>
                        <span className="resume-picker-card-custom-name">{customName}</span>
                        <span className="resume-picker-card-dir-label">{dirToTabName(ps.directory)}</span>
                      </>
                    ) : (
                      dirToTabName(ps.directory)
                    )}
                  </span>
                  <span className="resume-picker-card-date">
                    {formatRelativeDate(ps.lastModified)}
                  </span>
                </div>
                <div className="resume-picker-card-mid">
                  <span className="resume-picker-card-dir">
                    {abbreviatePath(ps.directory)}
                  </span>
                  {badge && (
                    <span className="resume-picker-card-model">{badge}</span>
                  )}
                  <span className="resume-picker-card-size">
                    {formatSize(ps.sizeBytes)}
                  </span>
                </div>
                <div className="resume-picker-card-messages">
                  {dead?.nodeSummary ? (
                    <span className="resume-picker-card-summary-haiku">
                      {dead.nodeSummary}
                    </span>
                  ) : (
                    <>
                      {ps.firstMessage && (
                        <div className="resume-picker-card-msg">
                          <span className="resume-picker-card-msg-arrow">{"\u25B8"}</span>
                          <span className="resume-picker-card-msg-text">{ps.firstMessage}</span>
                        </div>
                      )}
                      {ps.lastMessage && ps.lastMessage !== ps.firstMessage && (
                        <div className="resume-picker-card-msg resume-picker-card-msg-last">
                          <span className="resume-picker-card-msg-arrow">{"\u25B8"}</span>
                          <span className="resume-picker-card-msg-text">{ps.lastMessage}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Hint */}
        <div className="resume-picker-hint">
          <kbd>{"\u21B5"}</kbd> to resume &middot; <kbd>Ctrl+{"\u21B5"}</kbd> to configure
        </div>
      </div>
    </div>
  );
}
