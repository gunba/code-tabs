import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useActivityStore } from "../../store/activity";
import { useSessionStore } from "../../store/sessions";
import { AgentMascot } from "./AgentMascot";
import type { MascotState } from "./AgentMascot";
import { IconFolder, IconDocument, IconExternalLink } from "../Icons/Icons";
import { isSubagentActive } from "../../types/session";
import type { FileActivity, ContextFileEntry, FileChangeKind } from "../../types/activity";
import { buildFileTree, flattenTree, allFolderPaths } from "../../lib/fileTree";
import type { FileTreeNode } from "../../lib/fileTree";
import { canonicalizePath, splitFilePath } from "../../lib/paths";
import "./ActivityPanel.css";

const INDENT_STEP = 16;
const emptySet = new Set<string>();
const FOOTPRINT_LIMIT = 5;
// [AP-04] Floating mascot tracks the main agent; subagent inline mascots persist by last-touched file, and completed subagents stay dimmed at their last-touched file; indent at INDENT_STEP=16
// [AP-05] Two view modes: Response (since lastUserMessageAt) and Session (all visited paths)

/* -- Helpers -- */

function extractPathFromAction(action: string): string | null {
  const colonIdx = action.indexOf(": ");
  if (colonIdx === -1) return null;
  return action.slice(colonIdx + 2);
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit", "Grep", "Glob", "LSP"]);

function toolToMascotState(toolName: string): MascotState {
  if (toolName === "Read") return "reading";
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit" || toolName === "Bash") return "writing";
  if (toolName === "Grep" || toolName === "Glob" || toolName === "LSP") return "searching";
  return "idle";
}

function toolToVerb(toolName: string): string {
  if (toolName === "Read") return "Reading";
  if (toolName === "Edit" || toolName === "NotebookEdit") return "Editing";
  if (toolName === "Write") return "Writing";
  if (toolName === "Grep" || toolName === "Glob" || toolName === "LSP") return "Searching";
  if (toolName === "Bash") return "Running";
  return "Working on";
}

function toolToKind(toolName: string): FileChangeKind {
  if (toolName === "Read") return "read";
  if (toolName === "Edit" || toolName === "NotebookEdit") return "modified";
  if (toolName === "Write") return "created";
  if (toolName === "Grep" || toolName === "Glob" || toolName === "LSP") return "searched";
  return "read";
}

function relativeTime(ts: number, now: number): string {
  if (!ts) return "";
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface DiffDelta {
  added: number;
  removed: number;
}

function calculateDelta(activity: FileActivity): DiffDelta | null {
  const data = activity.toolInputData;
  if (!data) return null;
  if (data.type === "edit") {
    const oldLines = data.oldString.split("\n");
    const newLines = data.newString.split("\n");
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix++;
    return {
      removed: Math.max(0, oldLines.length - prefix - suffix),
      added: Math.max(0, newLines.length - prefix - suffix),
    };
  }
  if (data.type === "write") {
    const lines = data.content ? data.content.split("\n").length : 0;
    return { added: lines, removed: 0 };
  }
  return null;
}

interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

function buildUnifiedDiff(activity: FileActivity, maxLines: number = 24): DiffLine[] | null {
  const data = activity.toolInputData;
  if (!data) return null;

  if (data.type === "edit") {
    const oldLines = data.oldString.split("\n");
    const newLines = data.newString.split("\n");
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix++;

    const ctxBefore = Math.min(2, prefix);
    const ctxAfter = Math.min(2, suffix);
    const out: DiffLine[] = [];
    for (let i = prefix - ctxBefore; i < prefix; i++) out.push({ kind: "context", text: oldLines[i] });
    for (let i = prefix; i < oldLines.length - suffix; i++) out.push({ kind: "removed", text: oldLines[i] });
    for (let i = prefix; i < newLines.length - suffix; i++) out.push({ kind: "added", text: newLines[i] });
    for (let i = oldLines.length - suffix; i < oldLines.length - suffix + ctxAfter; i++) out.push({ kind: "context", text: oldLines[i] });
    return out.slice(0, maxLines);
  }

  if (data.type === "write") {
    const lines = data.content.split("\n").slice(0, maxLines);
    return lines.map((text) => ({ kind: "added", text }));
  }

  return null;
}

/** Strip workspace prefix to produce a workspace-relative display path. */
function workspaceRelative(fullPath: string, workspaceDir: string): string {
  if (!workspaceDir) return fullPath;
  const canonPath = canonicalizePath(fullPath);
  const canonWs = canonicalizePath(workspaceDir);
  if (canonPath === canonWs) return ".";
  if (canonPath.startsWith(canonWs + "/")) return canonPath.slice(canonWs.length + 1);
  return fullPath;
}

interface AgentOnFile {
  toolName: string;
  isSubagent: boolean;
  agentId: string | null;
  isCompleted?: boolean;
  /** Subagent type (e.g. "Explore", "Plan") — drives the AgentTypeIcon choice. */
  subagentType?: string | null;
}


/* -- Empty panel (no session / session ended) -- */

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="activity-panel">
      <div className="activity-panel-empty">
        <IconFolder size={32} className="activity-panel-empty-icon" />
        <span>{message}</span>
      </div>
    </div>
  );
}

/* -- Diff card (click-to-expand) -- */

function DiffCard({ activity, depth }: { activity: FileActivity; depth: number }) {
  const lines = useMemo(() => buildUnifiedDiff(activity), [activity]);
  const indent = depth * INDENT_STEP + 24;

  if (!lines || lines.length === 0) {
    if (activity.kind === "read") {
      return (
        <div className="file-tree-diff-card file-tree-diff-empty" style={{ paddingLeft: indent }}>
          <span className="file-tree-diff-empty-text">No diff captured for reads.</span>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="file-tree-diff-card" style={{ paddingLeft: indent }}>
      <div className="file-tree-diff-body">
        {lines.map((line, i) => (
          <div key={i} className={`file-tree-diff-line file-tree-diff-${line.kind}`}>
            <span className="file-tree-diff-gutter">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
            </span>
            <span className="file-tree-diff-text">{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -- Tree row component -- */

function FileTreeRow({
  node,
  depth,
  isExpanded,
  onToggleFolder,
  agents,
  contextInfo,
  onToggleFileExpand,
  onShellOpen,
  showMascotInline,
  activeSubagentIds,
  cli,
  isFloatingTarget,
  isFileExpanded,
  now,
}: {
  node: FileTreeNode;
  depth: number;
  isExpanded: boolean;
  onToggleFolder: (path: string) => void;
  agents: AgentOnFile[];
  contextInfo: ContextFileEntry | null;
  onToggleFileExpand: (path: string) => void;
  onShellOpen: (path: string) => void;
  /** Whether to show the inline mascot (false when floating mascot covers this file). */
  showMascotInline: boolean;
  /** Subagent ids currently tracked for this session (used to suppress stale 'searched' color). */
  activeSubagentIds: Set<string>;
  /** Active session CLI — picks the right mascot artwork. */
  cli: "claude" | "codex";
  /** True when the floating main-agent mascot is on this row. */
  isFloatingTarget: boolean;
  /** True when this file row is expanded to show inline diff. */
  isFileExpanded: boolean;
  /** Current time tick for relative timestamp display. */
  now: number;
}) {
  const indent = depth * INDENT_STEP;
  const primaryMascot = agents.length > 0 ? agents[0] : null;
  const extraAgentCount = agents.length > 1 ? agents.length - 1 : 0;
  const mascotState = primaryMascot ? toolToMascotState(primaryMascot.toolName) : null;

  const tooltip = contextInfo
    ? `${node.fullPath}\nContext: ${contextInfo.memoryType} (${contextInfo.loadReason})`
    : node.fullPath;

  const rowStyle: React.CSSProperties = {
    paddingLeft: indent + (node.isFile ? 4 : 0),
    ["--indent-width" as string]: `${indent}px`,
  };

  const kindClass = node.activity?.kind ? ` file-tree-kind-${node.activity.kind}` : "";
  const activeClass = isFloatingTarget ? " file-tree-row-active" : "";
  const expandedClass = isFileExpanded ? " file-tree-row-expanded" : "";

  if (node.isFile) {
    const inlineMascot = showMascotInline && mascotState && primaryMascot;
    const delta = node.activity ? calculateDelta(node.activity) : null;
    const ts = node.activity?.timestamp ?? 0;
    const tsLabel = ts ? relativeTime(ts, now) : "";

    return (
      <div
        className={`file-tree-row file-tree-file${activeClass}${expandedClass}`}
        style={rowStyle}
        onClick={() => onToggleFileExpand(node.fullPath)}
        title={tooltip}
        data-path={node.fullPath}
      >
        <span className="file-tree-icon-slot">
          {inlineMascot ? (
            <AgentMascot
              state={mascotState!}
              cli={cli}
              isSubagent={primaryMascot!.isSubagent}
              subagentType={primaryMascot!.subagentType}
              isCompleted={primaryMascot!.isCompleted}
              size={16}
            />
          ) : (
            <IconDocument size={14} />
          )}
        </span>
        <span className={`file-tree-name file-tree-filename${kindClass}`}>{node.name}</span>
        {extraAgentCount > 0 && (
          <span className="file-tree-agent-count">+{extraAgentCount}</span>
        )}
        <span className="file-tree-meta">
          {delta && (delta.added > 0 || delta.removed > 0) && (
            <span className="file-tree-delta">
              {delta.added > 0 && <span className="file-tree-delta-added">+{delta.added}</span>}
              {delta.removed > 0 && <span className="file-tree-delta-removed">−{delta.removed}</span>}
            </span>
          )}
          {tsLabel && <span className="file-tree-ts">{tsLabel}</span>}
          <button
            type="button"
            className="file-tree-open-btn"
            title="Open in editor"
            onClick={(e) => { e.stopPropagation(); onShellOpen(node.fullPath); }}
          >
            <IconExternalLink size={12} />
          </button>
        </span>
      </div>
    );
  }

  // [AP-06] Folder searched-color: main agent (agentId null) always wins; subagents only while in active set.
  const searchedAgentId =
    node.activity?.kind === "searched" ? node.activity.agentId : undefined;
  const searchedAgentStillActive =
    searchedAgentId === null || searchedAgentId === undefined
      ? true
      : activeSubagentIds.has(searchedAgentId);
  const showSearched =
    node.activity?.kind === "searched" && searchedAgentStillActive && !node.isWorkspaceRoot;
  const folderClasses = `file-tree-row file-tree-folder${node.isWorkspaceRoot ? " file-tree-workspace-root" : ""}${showSearched ? " file-tree-searched" : ""}`;

  const inlineMascot = showMascotInline && mascotState && primaryMascot;

  return (
    <div
      className={folderClasses}
      style={rowStyle}
      onClick={() => onToggleFolder(node.fullPath)}
      title={node.fullPath}
      data-path={node.fullPath}
    >
      <span className={`file-tree-chevron${isExpanded ? "" : " collapsed"}`}>
        {"▾"}
      </span>
      <span className="file-tree-icon-slot">
        {inlineMascot ? (
          <AgentMascot
            state={mascotState!}
            cli={cli}
            isSubagent={primaryMascot!.isSubagent}
            subagentType={primaryMascot!.subagentType}
            isCompleted={primaryMascot!.isCompleted}
            size={16}
          />
        ) : (
          <IconFolder size={14} />
        )}
      </span>
      <span className={`file-tree-name file-tree-foldername${kindClass}`}>{node.name}</span>
      {extraAgentCount > 0 && (
        <span className="file-tree-agent-count">+{extraAgentCount}</span>
      )}
    </div>
  );
}

/* -- Sticky mascot state -- */

interface StickyMascot {
  tabId: string;
  path: string;
  state: MascotState;
  isSubagent: boolean;
  top: number;
  left: number;
}

interface FootprintPosition {
  path: string;
  top: number;
  left: number;
  age: number; // 0 = newest
}

/* -- Panel header (storyteller mascot + narration) -- */

// [AP-07] Header band with 32px mascot + 2-line narration; verb derived from currentToolName, target chip tinted by kind
function PanelHeader({
  cli,
  mascotState,
  narrationVerb,
  narrationTarget,
  narrationPath,
  narrationKind,
  narrationDetail,
}: {
  cli: "claude" | "codex";
  mascotState: MascotState;
  narrationVerb: string;
  narrationTarget: string | null;
  narrationPath: string | null;
  narrationKind: FileChangeKind | null;
  narrationDetail: string | null;
}) {
  const targetClass = narrationKind ? `panel-header-target file-tree-kind-${narrationKind}` : "panel-header-target";
  return (
    <div className="activity-panel-header">
      <div className="activity-panel-header-mascot">
        <span className="activity-panel-header-glow" aria-hidden="true" />
        <AgentMascot
          state={mascotState}
          cli={cli}
          size={32}
          hideOverlay
        />
      </div>
      <div className="activity-panel-header-text">
        <div className="activity-panel-header-narration">
          <span className="panel-header-verb">{narrationVerb}</span>
          {narrationTarget && (
            <span className={targetClass}>{narrationTarget}</span>
          )}
          {narrationDetail && (
            <span className="panel-header-detail">{narrationDetail}</span>
          )}
        </div>
        {narrationPath && (
          <div className="activity-panel-header-path file-tree-path-mono" title={narrationPath}>
            {narrationPath}
          </div>
        )}
      </div>
    </div>
  );
}

/* -- Main panel -- */

export function ActivityPanel({ mode }: { mode: "response" | "session" }) {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const sessions = useSessionStore((s) => s.sessions);
  const storeSubagents = useSessionStore((s) => s.subagents);
  const activeSession = sessions.find((s) => s.id === activeTabId);

  const activity = useActivityStore((s) => activeTabId ? s.sessions[activeTabId] ?? null : null);
  const activityStore = useActivityStore.getState;

  const expandedPaths: Set<string> = activity?.expandedPaths ?? emptySet;

  const containerRef = useRef<HTMLDivElement>(null);
  const [mascot, setMascot] = useState<StickyMascot | null>(null);
  const [footprints, setFootprints] = useState<FootprintPosition[]>([]);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(emptySet);
  const [now, setNow] = useState<number>(() => Date.now());

  // 1Hz tick for relative-time labels. Cheap; one timer at panel level.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Reset per-tab: collapse all expanded files, clear footprints/mascot when tab changes
  useEffect(() => {
    setExpandedFiles(emptySet);
    setFootprints([]);
  }, [activeTabId]);

  // Derive the last file the main agent touched from activity data (persists across idle)
  const lastMainAgentFile = useMemo(() => {
    if (!activity) return null;
    for (let i = activity.turns.length - 1; i >= 0; i--) {
      const turn = activity.turns[i];
      for (let j = turn.files.length - 1; j >= 0; j--) {
        if (!turn.files[j].agentId) return turn.files[j];
      }
    }
    let latest: FileActivity | null = null;
    for (const f of Object.values(activity.allFiles)) {
      if (!f.agentId && (!latest || f.timestamp > latest.timestamp)) latest = f;
    }
    return latest;
  }, [activity]);

  // [AP-08] Recent main-agent paths for footprints (newest first, distinct, excluding current target)
  const recentMainAgentPaths = useMemo(() => {
    if (!activity) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = activity.turns.length - 1; i >= 0 && out.length < FOOTPRINT_LIMIT + 1; i--) {
      const turn = activity.turns[i];
      for (let j = turn.files.length - 1; j >= 0 && out.length < FOOTPRINT_LIMIT + 1; j--) {
        const f = turn.files[j];
        if (f.agentId) continue;
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        out.push(f.path);
      }
    }
    return out;
  }, [activity]);

  // Per-subagent last-touched files (for persistent inline mascots)
  const lastSubagentFiles = useMemo(() => {
    const map = new Map<string, FileActivity>();
    if (!activity) return map;
    for (const turn of activity.turns) {
      for (const f of turn.files) {
        if (f.agentId) {
          const existing = map.get(f.agentId);
          if (!existing || f.timestamp > existing.timestamp) {
            map.set(f.agentId, f);
          }
        }
      }
    }
    return map;
  }, [activity]);

  const activeSubagentIds = useMemo(() => {
    const ids = new Set<string>();
    const subs = activeTabId ? storeSubagents.get(activeTabId) ?? [] : [];
    for (const sub of subs) ids.add(sub.id);
    return ids;
  }, [activeTabId, storeSubagents]);

  const activeAgentFiles = useMemo(() => {
    const map = new Map<string, AgentOnFile[]>();
    if (!activeSession) return map;

    const pushAgent = (path: string, agent: AgentOnFile) => {
      const existing = map.get(path);
      if (existing) {
        if (existing.some((a) => a.agentId === agent.agentId)) return;
        existing.push(agent);
      } else {
        map.set(path, [agent]);
      }
    };

    const meta = activeSession.metadata;
    if (meta.currentAction && meta.currentToolName && FILE_TOOLS.has(meta.currentToolName)) {
      const path = extractPathFromAction(meta.currentAction);
      if (path) {
        pushAgent(canonicalizePath(path), { toolName: meta.currentToolName, isSubagent: false, agentId: null });
      }
    }

    const subs = activeTabId ? storeSubagents.get(activeTabId) ?? [] : [];
    const typeOf = (sub: { subagentType?: string | null; agentType?: string | null }) =>
      sub.subagentType ?? sub.agentType ?? null;
    for (const sub of subs) {
      if (!isSubagentActive(sub.state)) continue;
      if (sub.currentAction && sub.currentToolName && FILE_TOOLS.has(sub.currentToolName)) {
        const path = extractPathFromAction(sub.currentAction);
        if (path) {
          pushAgent(canonicalizePath(path), {
            toolName: sub.currentToolName,
            isSubagent: true,
            agentId: sub.id,
            subagentType: typeOf(sub),
          });
        }
      }
    }

    for (const sub of subs) {
      if (!isSubagentActive(sub.state)) continue;
      const lastFile = lastSubagentFiles.get(sub.id);
      if (lastFile) {
        const hasActive = [...map.values()].some((agents) =>
          agents.some((a) => a.agentId === sub.id),
        );
        if (!hasActive) {
          pushAgent(lastFile.path, {
            toolName: lastFile.toolName ?? "Read",
            isSubagent: true,
            agentId: sub.id,
            subagentType: typeOf(sub),
          });
        }
      }
    }

    for (const sub of subs) {
      if (isSubagentActive(sub.state)) continue;
      const lastFile = lastSubagentFiles.get(sub.id);
      if (lastFile) {
        const hasEntry = [...map.values()].some((agents) =>
          agents.some((a) => a.agentId === sub.id),
        );
        if (!hasEntry) {
          pushAgent(lastFile.path, {
            toolName: lastFile.toolName ?? "Read",
            isSubagent: true,
            agentId: sub.id,
            isCompleted: true,
            subagentType: typeOf(sub),
          });
        }
      }
    }

    return map;
  }, [
    activeSession?.metadata.currentAction,
    activeSession?.metadata.currentToolName,
    activeTabId,
    storeSubagents,
    lastSubagentFiles,
  ]);

  const primaryActive = useMemo(() => {
    for (const [path, agents] of activeAgentFiles) {
      const mainAgent = agents.find((a) => !a.isSubagent);
      if (mainAgent) return { path, agent: mainAgent };
    }
    return null;
  }, [activeAgentFiles]);

  const contextFileMap = useMemo(() => {
    const map = new Map<string, ContextFileEntry>();
    if (!activity) return map;
    for (const cf of activity.contextFiles) {
      map.set(cf.path, cf);
    }
    return map;
  }, [activity?.contextFiles]);

  const fileMap = useMemo(() => {
    const map = new Map<string, FileActivity>();
    if (!activity) return map;

    if (mode === "response") {
      const boundary = activity.lastUserMessageAt;
      for (const turn of activity.turns) {
        for (const f of turn.files) {
          if (f.timestamp >= boundary) {
            const existing = map.get(f.path);
            // AP-03 cross-turn: never downgrade "created" to "modified" within same response
            if (existing?.kind === "created" && f.kind === "modified") {
              map.set(f.path, { ...f, kind: "created" });
            } else {
              map.set(f.path, f);
            }
          }
        }
      }
    } else {
      for (const path of activity.visitedPaths) {
        const entry = activity.allFiles[path];
        if (entry) {
          map.set(path, entry);
        } else {
          map.set(path, {
            path,
            kind: "read",
            agentId: null,
            toolName: null,
            timestamp: 0,
            confirmed: true,
            isExternal: false,
            permissionDenied: false,
            permissionMode: null,
            toolInputData: null,
            isFolder: false,
          });
        }
      }
    }

    return map;
  }, [activity, mode]);

  const workspaceDir = activeSession?.config.workingDir ?? "";
  const tree = useMemo(
    () => buildFileTree(fileMap, canonicalizePath(workspaceDir)),
    [fileMap, workspaceDir],
  );

  useEffect(() => {
    if (tree.length === 0 || !activeTabId) return;
    const newFolders = allFolderPaths(tree);
    activityStore().mergeExpandedPaths(activeTabId, newFolders);
  }, [tree, activeTabId]);

  const rows = useMemo(() => flattenTree(tree, expandedPaths), [tree, expandedPaths]);

  const depthByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.node.fullPath, row.depth);
    }
    return map;
  }, [rows]);

  // Update floating mascot position
  useEffect(() => {
    if (!containerRef.current || !activeTabId) return;

    const target = primaryActive
      ? { path: primaryActive.path, state: toolToMascotState(primaryActive.agent.toolName) }
      : lastMainAgentFile
        ? { path: lastMainAgentFile.path, state: "idle" as MascotState }
        : null;

    if (!target) {
      setMascot(null);
      return;
    }

    const rowEl = containerRef.current.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(target.path)}"]`,
    );
    if (!rowEl) {
      setMascot(null);
      return;
    }

    const depth = depthByPath.get(target.path) ?? 0;
    const containerRect = containerRef.current.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const scrollTop = containerRef.current.scrollTop;

    setMascot({
      tabId: activeTabId,
      path: target.path,
      state: target.state,
      isSubagent: false,
      top: rowRect.top - containerRect.top + scrollTop + rowRect.height / 2 - 8,
      left: 8 + (depth - 1) * INDENT_STEP,
    });
  }, [activeTabId, primaryActive, lastMainAgentFile, depthByPath, rows]);

  // Compute footprint positions: skip the current floating-mascot path
  useEffect(() => {
    if (!containerRef.current || !activeTabId) {
      setFootprints([]);
      return;
    }
    const currentPath = mascot?.tabId === activeTabId ? mascot.path : null;
    const containerRect = containerRef.current.getBoundingClientRect();
    const scrollTop = containerRef.current.scrollTop;
    const positions: FootprintPosition[] = [];
    let age = 0;
    for (const path of recentMainAgentPaths) {
      if (path === currentPath) continue;
      if (positions.length >= FOOTPRINT_LIMIT) break;
      const rowEl = containerRef.current.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(path)}"]`,
      );
      if (!rowEl) {
        age++;
        continue;
      }
      const depth = depthByPath.get(path) ?? 0;
      const rowRect = rowEl.getBoundingClientRect();
      positions.push({
        path,
        top: rowRect.top - containerRect.top + scrollTop + rowRect.height / 2 - 2,
        left: 6 + (depth - 1) * INDENT_STEP,
        age: age++,
      });
    }
    setFootprints(positions);
  }, [activeTabId, recentMainAgentPaths, mascot, depthByPath, rows]);

  const toggleFolder = useCallback((path: string) => {
    if (activeTabId) activityStore().toggleExpandedPath(activeTabId, path);
  }, [activeTabId]);

  // [AP-09] Click on file row toggles expandedFiles; shell_open moved to dedicated icon button
  const toggleFileExpand = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleShellOpen = useCallback((filePath: string) => {
    invoke("shell_open", { path: filePath }).catch(() => {});
  }, []);

  // Header narration: derived from active tool call → fallback to last main-agent file
  const cli = activeSession?.config.cli ?? "claude";
  const headerNarration = useMemo(() => {
    if (!activeSession) {
      return {
        mascotState: "idle" as MascotState,
        narrationVerb: "Waiting…",
        narrationTarget: null as string | null,
        narrationPath: null as string | null,
        narrationKind: null as FileChangeKind | null,
        narrationDetail: null as string | null,
      };
    }
    if (primaryActive) {
      const tool = primaryActive.agent.toolName;
      const verb = toolToVerb(tool);
      const isFolder = tool === "Grep" || tool === "Glob" || tool === "LSP";
      const split = splitFilePath(primaryActive.path);
      const target = isFolder ? (split.name || primaryActive.path) : split.name;
      return {
        mascotState: toolToMascotState(tool),
        narrationVerb: verb,
        narrationTarget: target,
        narrationPath: workspaceRelative(primaryActive.path, workspaceDir),
        narrationKind: toolToKind(tool),
        narrationDetail: null,
      };
    }
    if (lastMainAgentFile) {
      const split = splitFilePath(lastMainAgentFile.path);
      return {
        mascotState: "idle" as MascotState,
        narrationVerb: "Idle —",
        narrationTarget: split.name,
        narrationPath: workspaceRelative(lastMainAgentFile.path, workspaceDir),
        narrationKind: lastMainAgentFile.kind,
        narrationDetail: relativeTime(lastMainAgentFile.timestamp, now),
      };
    }
    return {
      mascotState: "idle" as MascotState,
      narrationVerb: "Waiting for the agent…",
      narrationTarget: null,
      narrationPath: null,
      narrationKind: null,
      narrationDetail: null,
    };
  }, [activeSession, primaryActive, lastMainAgentFile, workspaceDir, now]);

  if (!activeSession) return <EmptyPanel message="No active session" />;
  if (activeSession.state === "dead") return <EmptyPanel message="Session ended" />;

  const showEmptyBody = rows.length === 0;

  return (
    <div className="activity-panel">
      <PanelHeader
        cli={cli}
        mascotState={headerNarration.mascotState}
        narrationVerb={headerNarration.narrationVerb}
        narrationTarget={headerNarration.narrationTarget}
        narrationPath={headerNarration.narrationPath}
        narrationKind={headerNarration.narrationKind}
        narrationDetail={headerNarration.narrationDetail}
      />
      <div className="activity-panel-body activity-tree-container" ref={containerRef}>
        {showEmptyBody ? (
          <div className="activity-panel-empty activity-panel-empty-rich">
            <AgentMascot state="idle" cli={cli} size={48} hideOverlay />
            <span className="activity-panel-empty-title">
              {mode === "response" ? "Waiting for the agent to do something…" : "No files visited yet"}
            </span>
            <span className="activity-panel-empty-sub">
              {mode === "response"
                ? "File reads, edits, and searches will appear here as the agent works."
                : "Switch to Response to follow the current turn."}
            </span>
          </div>
        ) : (
          <>
            {rows.map((row) => {
              const agents = activeAgentFiles.get(row.node.fullPath) ?? [];
              const currentMascot = mascot?.tabId === activeTabId ? mascot : null;
              const isFloatingTarget = currentMascot?.path === row.node.fullPath;
              const subagentOnly = agents.filter((a) => a.isSubagent);
              const isFileExpanded = row.node.isFile && expandedFiles.has(row.node.fullPath);

              return (
                <div key={row.key} className="file-tree-row-wrapper">
                  <FileTreeRow
                    node={row.node}
                    depth={row.depth}
                    isExpanded={expandedPaths.has(row.node.fullPath)}
                    onToggleFolder={toggleFolder}
                    agents={isFloatingTarget ? subagentOnly : agents}
                    contextInfo={row.node.isFile ? contextFileMap.get(row.node.fullPath) ?? null : null}
                    onToggleFileExpand={toggleFileExpand}
                    onShellOpen={handleShellOpen}
                    showMascotInline={!isFloatingTarget}
                    activeSubagentIds={activeSubagentIds}
                    cli={cli}
                    isFloatingTarget={isFloatingTarget}
                    isFileExpanded={isFileExpanded}
                    now={now}
                  />
                  {isFileExpanded && row.node.activity && (
                    <DiffCard activity={row.node.activity} depth={row.depth} />
                  )}
                </div>
              );
            })}
            {footprints.map((fp) => (
              <span
                key={`fp-${fp.path}`}
                className="activity-footprint"
                style={{
                  top: fp.top,
                  left: fp.left,
                  opacity: Math.max(0.08, 0.42 - fp.age * 0.08),
                }}
                aria-hidden="true"
              />
            ))}
            {mascot && mascot.tabId === activeTabId && (
              <div
                className="activity-mascot-float"
                style={{ top: mascot.top, left: mascot.left }}
              >
                <AgentMascot
                  state={mascot.state}
                  cli={cli}
                  isSubagent={mascot.isSubagent}
                  size={16}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
