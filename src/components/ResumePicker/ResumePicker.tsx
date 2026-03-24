import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { getResumeId, modelLabel, stripWorktreeFlags } from "../../lib/claude";
import { dirToTabName, abbreviatePath, normalizeForFilter } from "../../lib/paths";
import { useCtrlKey } from "../../hooks/useCtrlKey";
import {
  type PastSession,
  type ContentSearchMatch,
  type SessionConfig,
  DEFAULT_SESSION_CONFIG,
} from "../../types/session";
import { IconFolder } from "../Icons/Icons";
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

// ── Suppressed messages (plan-mode artifacts) ─────────────────────
const SUPPRESSED_FIRST_MESSAGES = [
  "[Request interrupted by user for tool use]",
  "Request interrupted by user for tool use",
];

// ── Badge label maps ─────────────────────────────────────────────
const PERM_LABELS: Record<string, string> = {
  acceptEdits: "Accept Edits",
  bypassPermissions: "Bypass",
  dontAsk: "Don't Ask",
  planMode: "Plan",
  auto: "Auto",
};
const EFFORT_LABELS: Record<string, string> = { low: "Low", high: "High", max: "Max" };

// ── Dead session entry ───────────────────────────────────────────
type DeadEntry = { appSessionId: string; nodeSummary: string | null; config: SessionConfig };

// ── Chain merging types ──────────────────────────────────────────
interface MergedChain {
  resumeSession: PastSession;    // Latest session (the one to resume)
  members: PastSession[];        // All sessions, newest first
  displayName: string | null;    // Resolved custom name from any member
  latestDate: string;            // Max lastModified across chain
  totalSize: number;             // Sum of sizeBytes
  firstMessage: string;          // Best non-suppressed firstMessage (prefer parent)
  lastMessage: string;           // From latest session
  model: string;                 // From latest session
  chainLength: number;           // 1 = standalone
}

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

  // Content search state (modal-scoped, not in Zustand)
  const [contentResults, setContentResults] = useState<ContentSearchMatch[]>([]);
  const [contentSearching, setContentSearching] = useState(false);
  const searchCounterRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refresh past sessions on mount (background, non-blocking — data may already be preloaded)
  useEffect(() => {
    loadPastSessions();
    filterRef.current?.focus();
  }, [loadPastSessions]);

  // Debounced content search — triggers 400ms after typing stops, min 3 chars
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (dirFilter.trim().length < 3) {
      setContentResults([]);
      setContentSearching(false);
      return;
    }

    setContentSearching(true);
    const counter = ++searchCounterRef.current;

    debounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await invoke<ContentSearchMatch[]>("search_session_content", { query: dirFilter.trim() });
        if (searchCounterRef.current === counter) {
          setContentResults(results);
        }
      } catch (err) {
        console.error("Content search failed:", err);
      } finally {
        if (searchCounterRef.current === counter) {
          setContentSearching(false);
        }
      }
    }, 400);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [dirFilter]);

  // Dead session map: CLI session ID -> DeadEntry
  const deadSessionMap = useMemo(() => {
    const map = new Map<string, DeadEntry>();
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

  /** Find a dead session entry across all members of a chain */
  const findDead = useCallback(
    (chain: MergedChain): DeadEntry | undefined => {
      for (const m of chain.members) {
        const d = deadSessionMap.get(m.id);
        if (d) return d;
      }
    },
    [deadSessionMap]
  );

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
        if (dirNorm.includes(filterNorm) || filterNorm.includes(dirNorm)) return true;
        const name = sessionNames[ps.id];
        if (name && normalizeForFilter(name).includes(filterNorm)) return true;
        return false;
      });
    }
    return list;
  }, [pastSessions, dirFilter, deadSessionMap, sessionNames]);

  // Merge chain sessions into single entries
  const mergedList = useMemo((): MergedChain[] => {
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

    // Recursively collect all descendants of a session (visited set guards against cycles)
    const collectDescendants = (id: string, visited = new Set<string>()): PastSession[] => {
      if (visited.has(id)) return [];
      visited.add(id);
      const direct = childrenOf.get(id) || [];
      const all: PastSession[] = [...direct];
      for (const child of direct) {
        all.push(...collectDescendants(child.id, visited));
      }
      return all;
    };

    const chains: MergedChain[] = [];
    for (const ps of filteredPastSessions) {
      // Skip children — they'll be merged into their root chain
      if (childIds.has(ps.id)) continue;

      const descendants = collectDescendants(ps.id);
      // All members: root + all descendants, sorted newest-first
      const members = [ps, ...descendants].sort(
        (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
      );
      const latest = members[0];

      // Resolve display name: first member that has a sessionNames entry
      let displayName: string | null = null;
      for (const m of members) {
        if (sessionNames[m.id]) {
          displayName = sessionNames[m.id];
          break;
        }
      }

      // Pick firstMessage: check root first, then descendants, skip suppressed
      let firstMessage = "";
      if (ps.firstMessage && !SUPPRESSED_FIRST_MESSAGES.includes(ps.firstMessage)) {
        firstMessage = ps.firstMessage;
      } else for (const m of descendants) {
        if (m.firstMessage && !SUPPRESSED_FIRST_MESSAGES.includes(m.firstMessage)) {
          firstMessage = m.firstMessage;
          break;
        }
      }

      // Pick lastMessage: prefer latest, fall back through members
      let lastMessage = "";
      for (const m of members) {
        if (m.lastMessage && !SUPPRESSED_FIRST_MESSAGES.includes(m.lastMessage)) {
          lastMessage = m.lastMessage;
          break;
        }
      }

      chains.push({
        resumeSession: latest,
        members,
        displayName,
        latestDate: latest.lastModified,  // members sorted newest-first
        totalSize: members.reduce((sum, m) => sum + m.sizeBytes, 0),
        firstMessage,
        lastMessage,
        model: latest.model,
        chainLength: members.length,
      });
    }
    return chains;
  }, [filteredPastSessions, sessionNames]);

  // Snippet map from content search results
  const snippetMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of contentResults) {
      map.set(r.sessionId, r.snippet);
    }
    return map;
  }, [contentResults]);

  // Merge metadata results with content-only results
  const { displayList, contentDividerIndex } = useMemo(() => {
    const metadataIds = new Set<string>();
    for (const chain of mergedList) {
      for (const m of chain.members) {
        metadataIds.add(m.id);
      }
    }

    // Find content-only matches (sessions not already in metadata results)
    const pastSessionMap = new Map<string, PastSession>();
    for (const ps of pastSessions) {
      pastSessionMap.set(ps.id, ps);
    }

    const additionalChains: MergedChain[] = [];
    for (const r of contentResults) {
      if (metadataIds.has(r.sessionId)) continue;
      const ps = pastSessionMap.get(r.sessionId);
      if (!ps) continue;

      additionalChains.push({
        resumeSession: ps,
        members: [ps],
        displayName: sessionNames[ps.id] || null,
        latestDate: ps.lastModified,
        totalSize: ps.sizeBytes,
        firstMessage: ps.firstMessage,
        lastMessage: ps.lastMessage,
        model: ps.model,
        chainLength: 1,
      });
    }

    return {
      displayList: [...mergedList, ...additionalChains],
      contentDividerIndex: additionalChains.length > 0 ? mergedList.length : -1,
    };
  }, [mergedList, contentResults, pastSessions, sessionNames]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [dirFilter]);

  // Scroll selected card into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const cards = container.querySelectorAll(".resume-picker-card");
    const card = cards[selectedIndex] as HTMLElement | undefined;
    card?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Resume a specific PastSession by ID
  const resumeById = useCallback(
    async (ps: PastSession, displayName?: string | null) => {
      const workingDir = ps.directory || ".";
      const dead = deadSessionMap.get(ps.id);
      const cached = sessionConfigs[ps.id];
      const baseConfig = dead?.config ?? { ...DEFAULT_SESSION_CONFIG, ...cached };
      const resumeConfig: SessionConfig = {
        ...baseConfig,
        workingDir,
        resumeSession: ps.id,
        continueSession: false,
        extraFlags: stripWorktreeFlags(baseConfig.extraFlags),
      };
      addRecentDir(workingDir);
      const name = displayName || sessionNames[ps.id] || ps.path;

      if (activeIsDead && activeSession) {
        requestRespawn(activeSession.id, resumeConfig, name);
        onClose();
        return;
      }

      try {
        await createSession(name, resumeConfig);
        onClose();
      } catch (err) {
        console.error("Failed to resume session:", err);
      }
    },
    [deadSessionMap, sessionConfigs, sessionNames, activeIsDead, activeSession, createSession, addRecentDir, requestRespawn, onClose]
  );

  // Resume a chain (latest member)
  const handleResume = useCallback(
    (chain: MergedChain) => resumeById(chain.resumeSession, chain.displayName),
    [resumeById]
  );

  // Open the main launcher with this session pre-filled (Ctrl+Click / Configure)
  const handleConfigure = useCallback(
    (chain: MergedChain) => {
      const ps = chain.resumeSession;
      const dead = findDead(chain);
      const cached = sessionConfigs[ps.id];
      const baseConfig = dead?.config ?? { ...DEFAULT_SESSION_CONFIG, ...cached };
      const prefillConfig: SessionConfig = {
        ...baseConfig,
        workingDir: ps.directory,
        resumeSession: ps.id,
        continueSession: false,
        extraFlags: stripWorktreeFlags(baseConfig.extraFlags),
      };
      setLastConfig(prefillConfig);
      onClose();
      setShowLauncher(true);
    },
    [findDead, sessionConfigs, setLastConfig, onClose, setShowLauncher]
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
      if (e.key === "Enter" && displayList.length > 0) {
        e.preventDefault();
        const chain = displayList[selectedIndex] ?? displayList[0];
        if (e.ctrlKey) {
          handleConfigure(chain);
        } else {
          handleResume(chain);
        }
        return;
      }
      if (e.key === "ArrowDown" && displayList.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, displayList.length - 1));
      }
      if (e.key === "ArrowUp" && displayList.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, displayList, selectedIndex, handleResume, handleConfigure]);

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
            placeholder="Filter by name, directory, or conversation content..."
            autoComplete="off"
          />
          <button
            className="resume-picker-browse"
            onClick={handleBrowseFilter}
            title="Browse"
            type="button"
          >
            <IconFolder size={14} />
          </button>
        </div>

        {/* Session list */}
        <div className="resume-picker-list" ref={listRef}>
          {displayList.length === 0 && !contentSearching && (
            <div className="resume-picker-empty">
              {pastSessionsLoading
                ? "Loading sessions..."
                : pastSessions.length === 0
                  ? "No past sessions found"
                  : "No sessions match filter"}
            </div>
          )}
          {displayList.map((chain, idx) => {
            const ps = chain.resumeSession;
            const dead = findDead(chain);
            const isSelected = idx === selectedIndex;
            const modelBadge = shortModelBadge(chain.model);
            const isContentOnly = idx >= contentDividerIndex && contentDividerIndex >= 0;
            const snippet = snippetMap.get(ps.id);

            // Resolve config for badge display
            const cached = sessionConfigs[ps.id];
            const config = dead?.config ?? cached;

            // Build badges (all share base class + color modifier)
            const badges: { label: string; mod: string }[] = [];
            if (modelBadge) badges.push({ label: modelBadge, mod: "resume-picker-badge-model" });
            if (config?.dangerouslySkipPermissions) badges.push({ label: "Skip Perms", mod: "resume-picker-badge-danger" });
            if (config?.permissionMode && config.permissionMode !== "default") {
              badges.push({ label: PERM_LABELS[config.permissionMode] || config.permissionMode, mod: "resume-picker-badge-perm" });
            }
            if (config?.effort && config.effort !== "medium") {
              badges.push({ label: EFFORT_LABELS[config.effort] || config.effort, mod: "resume-picker-badge-effort" });
            }
            if (config?.agent) badges.push({ label: config.agent, mod: "resume-picker-badge-agent" });

            const cardClass = [
              "resume-picker-card",
              isSelected && "resume-picker-card-selected",
              chain.chainLength > 1 && "resume-picker-card-chain",
              isContentOnly && "resume-picker-card-content-match",
            ].filter(Boolean).join(" ");

            return (
              <React.Fragment key={ps.id}>
                {idx === contentDividerIndex && (
                  <div className="resume-picker-content-divider" />
                )}
              <div
                className={cardClass}
                onClick={(e) => {
                  if (e.ctrlKey) {
                    handleConfigure(chain);
                  } else {
                    handleResume(chain);
                  }
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                title={ctrlHeld
                  ? `Ctrl+Click: Configure & relaunch\n${ps.directory}`
                  : `${ps.directory}\nSession: ${ps.id}\nCtrl+Click to configure`}
              >
                <div className="resume-picker-card-top">
                  <span className="resume-picker-card-name">
                    {chain.displayName ? (
                      <>
                        <span className="resume-picker-card-custom-name">{chain.displayName}</span>
                        <span className="resume-picker-card-dir-label">{dirToTabName(ps.directory)}</span>
                      </>
                    ) : (
                      dirToTabName(ps.directory)
                    )}
                  </span>
                  <span className="resume-picker-card-date">
                    {formatRelativeDate(chain.latestDate)}
                  </span>
                </div>
                <div className="resume-picker-card-mid">
                  <span className="resume-picker-card-dir">
                    {abbreviatePath(ps.directory)}
                  </span>
                  {badges.map((b) => (
                    <span key={b.mod} className={`resume-picker-badge ${b.mod}`}>{b.label}</span>
                  ))}
                  {chain.chainLength > 1 && (
                    <span
                      className={`resume-picker-card-chain-count${expandedChains.has(ps.id) ? " resume-picker-card-chain-count-active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedChains((s) => {
                          const next = new Set(s);
                          next.has(ps.id) ? next.delete(ps.id) : next.add(ps.id);
                          return next;
                        });
                      }}
                      title="Click to show chain members"
                    >
                      {expandedChains.has(ps.id) ? "\u25BE" : "\u25B8"} {chain.chainLength} sessions
                    </span>
                  )}
                  <span className="resume-picker-card-size">
                    {formatSize(chain.totalSize)}
                  </span>
                </div>
                <div className="resume-picker-card-messages">
                  {dead?.nodeSummary ? (
                    <span className="resume-picker-card-summary-haiku">
                      {dead.nodeSummary}
                    </span>
                  ) : (
                    <>
                      {chain.firstMessage && (
                        <div className="resume-picker-card-msg">
                          <span className="resume-picker-card-msg-arrow">{"\u25B8"}</span>
                          <span className="resume-picker-card-msg-text">{chain.firstMessage}</span>
                        </div>
                      )}
                      {chain.lastMessage && chain.lastMessage !== chain.firstMessage && (
                        <div className="resume-picker-card-msg resume-picker-card-msg-last">
                          <span className="resume-picker-card-msg-arrow">{"\u25B8"}</span>
                          <span className="resume-picker-card-msg-text">{chain.lastMessage}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {/* Content search snippet */}
                {snippet && (
                  <div className="resume-picker-card-snippet">
                    <span className="resume-picker-card-snippet-label">MATCH</span>
                    <span className="resume-picker-card-snippet-text">{snippet}</span>
                  </div>
                )}
                {/* Expanded chain members */}
                {chain.chainLength > 1 && expandedChains.has(ps.id) && (
                  <div className="resume-picker-chain-members">
                    {chain.members.map((m) => (
                      <div
                        key={m.id}
                        className={`resume-picker-chain-member${m.id === chain.resumeSession.id ? " resume-picker-chain-member-latest" : ""}`}
                        onClick={(e) => { e.stopPropagation(); resumeById(m); }}
                        title={`Resume this session\n${m.id}`}
                      >
                        <span className="resume-picker-chain-member-date">
                          {formatRelativeDate(m.lastModified)}
                        </span>
                        <span className="resume-picker-chain-member-msg">
                          {m.firstMessage || "(no message)"}
                        </span>
                        <span className="resume-picker-card-size">
                          {formatSize(m.sizeBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </React.Fragment>
            );
          })}
          {contentSearching && dirFilter.trim().length >= 3 && (
            <div className="resume-picker-content-searching">Searching conversations...</div>
          )}
        </div>

        {/* Hint */}
        <div className="resume-picker-hint">
          <kbd>{"\u21B5"}</kbd> to resume &middot; <kbd>Ctrl+{"\u21B5"}</kbd> to configure
        </div>
      </div>
    </div>
  );
}
