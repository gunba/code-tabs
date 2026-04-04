import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useActivityStore } from "../../store/activity";
import { useSessionStore } from "../../store/sessions";
import { ClaudeMascot } from "./ClaudeMascot";
import type { MascotState } from "./ClaudeMascot";
import { IconClose } from "../Icons/Icons";
import { splitFilePath } from "../../lib/diffParser";
import { isSubagentActive } from "../../types/session";
import type { FileActivity, TurnActivity } from "../../types/activity";
import "./ActivityPanel.css";

interface ActivityPanelProps {
  onClose: () => void;
}

/* -- Helpers -- */

function extractPathFromAction(action: string): string | null {
  const colonIdx = action.indexOf(": ");
  if (colonIdx === -1) return null;
  return action.slice(colonIdx + 2);
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);

function toolToMascotState(toolName: string): MascotState {
  if (toolName === "Read") return "reading";
  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") return "writing";
  return "idle";
}

function kindToStatusChar(kind: string): string {
  switch (kind) {
    case "modified": return "M";
    case "created": return "C";
    case "deleted": return "D";
    case "read": return "R";
    case "renamed": return "R";
    default: return "?";
  }
}

function turnStatsLabel(turn: TurnActivity): string {
  let r = 0, m = 0, c = 0, d = 0;
  for (const f of turn.files) {
    switch (f.kind) {
      case "read": r++; break;
      case "modified": m++; break;
      case "created": c++; break;
      case "deleted": d++; break;
    }
  }
  const parts: string[] = [];
  if (r > 0) parts.push(`R:${r}`);
  if (m > 0) parts.push(`M:${m}`);
  if (c > 0) parts.push(`C:${c}`);
  if (d > 0) parts.push(`D:${d}`);
  return parts.join(" ") || `${turn.files.length} files`;
}

/* -- File item component -- */

function FileItem({
  file,
  agentInfo,
  onClick,
}: {
  file: FileActivity;
  agentInfo?: { toolName: string; isSubagent: boolean };
  onClick: (path: string) => void;
}) {
  const { dir, name } = splitFilePath(file.path);
  const statusChar = kindToStatusChar(file.kind);
  const statusCls = `activity-file-status status-${statusChar}`;
  const mascotState = agentInfo ? toolToMascotState(agentInfo.toolName) : null;

  return (
    <div
      className={`activity-file-item${file.permissionDenied ? " denied" : ""}`}
      onClick={() => onClick(file.path)}
      title={file.path}
    >
      <span className="activity-mascot-slot">
        {mascotState && (
          <ClaudeMascot
            state={mascotState}
            isSubagent={agentInfo?.isSubagent}
            size={20}
          />
        )}
      </span>
      <span className={statusCls}>{statusChar}</span>
      <span className="activity-file-path">
        {dir && <span className="activity-file-dir">{dir}</span>}
        <span className="activity-file-name">{name}</span>
      </span>
      {file.isExternal && <span className="activity-badge activity-badge-external">ext</span>}
      {file.permissionDenied && <span className="activity-badge activity-badge-denied">denied</span>}
      {!file.confirmed && file.kind !== "read" && (
        <span className="activity-badge activity-badge-unconfirmed">pending</span>
      )}
    </div>
  );
}

/* -- Empty panel -- */

function EmptyPanel({ onClose, message }: { onClose: () => void; message: string }) {
  return (
    <div className="activity-panel">
      <div className="activity-panel-header">
        <span className="activity-panel-title">Activity</span>
        <span className="activity-panel-spacer" />
        <button className="activity-panel-close" onClick={onClose} title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>
      <div className="activity-panel-empty">{message}</div>
    </div>
  );
}

/* -- Main panel -- */

export function ActivityPanel({ onClose }: ActivityPanelProps) {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const sessions = useSessionStore((s) => s.sessions);
  const storeSubagents = useSessionStore((s) => s.subagents);
  const activeSession = sessions.find((s) => s.id === activeTabId);

  const activitySessions = useActivityStore((s) => s.sessions);
  const activity = activeTabId ? activitySessions[activeTabId] ?? null : null;

  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set());
  const [contextCollapsed, setContextCollapsed] = useState(false);

  // Track previous stats for tick animation
  const prevStatsRef = useRef({ modified: 0, created: 0, deleted: 0 });
  const stats = activity?.stats ?? { filesModified: 0, filesCreated: 0, filesDeleted: 0, filesRead: 0 };
  const modChanged = stats.filesModified !== prevStatsRef.current.modified;
  const creChanged = stats.filesCreated !== prevStatsRef.current.created;
  const delChanged = stats.filesDeleted !== prevStatsRef.current.deleted;
  useEffect(() => {
    prevStatsRef.current = {
      modified: stats.filesModified,
      created: stats.filesCreated,
      deleted: stats.filesDeleted,
    };
  }, [stats.filesModified, stats.filesCreated, stats.filesDeleted]);

  // Reset collapsed state on session switch
  useEffect(() => {
    setCollapsedTurns(new Set());
    setContextCollapsed(false);
  }, [activeTabId]);

  // Build map of file paths currently being worked on by agents
  const activeAgentFiles = useMemo(() => {
    const map = new Map<string, { toolName: string; isSubagent: boolean }>();
    if (!activeSession) return map;

    // Main agent
    const meta = activeSession.metadata;
    if (meta.currentAction && meta.currentToolName && FILE_TOOLS.has(meta.currentToolName)) {
      const path = extractPathFromAction(meta.currentAction);
      if (path) {
        map.set(path, { toolName: meta.currentToolName, isSubagent: false });
      }
    }

    // Subagents
    const subs = activeTabId ? storeSubagents.get(activeTabId) ?? [] : [];
    for (const sub of subs) {
      if (!isSubagentActive(sub.state)) continue;
      if (sub.currentAction && sub.currentToolName && FILE_TOOLS.has(sub.currentToolName)) {
        const path = extractPathFromAction(sub.currentAction);
        if (path) {
          map.set(path, { toolName: sub.currentToolName, isSubagent: true });
        }
      }
    }

    return map;
  }, [
    activeSession?.metadata.currentAction,
    activeSession?.metadata.currentToolName,
    activeTabId,
    storeSubagents,
  ]);

  const toggleTurn = useCallback((turnId: string) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  const handleFileClick = useCallback((filePath: string) => {
    invoke("shell_open", { path: filePath }).catch(() => {});
  }, []);

  // Reversed turns for display (most recent first)
  const displayTurns = useMemo(() => {
    if (!activity) return [];
    return [...activity.turns].reverse();
  }, [activity?.turns]);

  if (!activeSession) return <EmptyPanel onClose={onClose} message="No active session" />;
  if (activeSession.state === "dead") return <EmptyPanel onClose={onClose} message="Session ended" />;

  const contextFiles = activity?.contextFiles ?? [];
  const hasContent = displayTurns.length > 0 || contextFiles.length > 0;

  return (
    <div className="activity-panel">
      <div className="activity-panel-header">
        <span className="activity-panel-title">Activity</span>
        <span className="activity-panel-spacer" />
        <div className="activity-panel-stats">
          {stats.filesModified > 0 && (
            <span
              className={`activity-stat activity-stat-modified${modChanged ? " activity-stat-tick" : ""}`}
              key={`mod-${stats.filesModified}`}
            >
              {stats.filesModified}M
            </span>
          )}
          {stats.filesCreated > 0 && (
            <span
              className={`activity-stat activity-stat-created${creChanged ? " activity-stat-tick" : ""}`}
              key={`cre-${stats.filesCreated}`}
            >
              {stats.filesCreated}C
            </span>
          )}
          {stats.filesDeleted > 0 && (
            <span
              className={`activity-stat activity-stat-deleted${delChanged ? " activity-stat-tick" : ""}`}
              key={`del-${stats.filesDeleted}`}
            >
              {stats.filesDeleted}D
            </span>
          )}
        </div>
        <button className="activity-panel-close" onClick={onClose} title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>

      <div className="activity-panel-body">
        {!hasContent ? (
          <div className="activity-panel-empty">No activity yet</div>
        ) : (
          <>
            {displayTurns.map((turn, i) => {
              const isLatest = i === 0;
              const isCollapsed = collapsedTurns.has(turn.turnId);
              const label = isLatest && !turn.endedAt
                ? "Current Turn"
                : `Turn ${displayTurns.length - i}`;

              if (turn.files.length === 0) return null;

              return (
                <div key={turn.turnId}>
                  <div className="activity-turn-header" onClick={() => toggleTurn(turn.turnId)}>
                    <span className={`activity-turn-chevron${isCollapsed ? " collapsed" : ""}`}>
                      {"\u25BE"}
                    </span>
                    {label}
                    <span className="activity-turn-stats">{turnStatsLabel(turn)}</span>
                  </div>
                  {!isCollapsed &&
                    turn.files.map((file) => (
                      <FileItem
                        key={`${file.path}-${file.timestamp}`}
                        file={file}
                        agentInfo={activeAgentFiles.get(file.path)}
                        onClick={handleFileClick}
                      />
                    ))}
                </div>
              );
            })}

            {contextFiles.length > 0 && (
              <>
                <div
                  className="activity-context-header"
                  onClick={() => setContextCollapsed(!contextCollapsed)}
                >
                  <span className={`activity-turn-chevron${contextCollapsed ? " collapsed" : ""}`}>
                    {"\u25BE"}
                  </span>
                  Context
                  <span className="activity-turn-stats">{contextFiles.length}</span>
                </div>
                {!contextCollapsed &&
                  contextFiles.map((cf) => (
                    <div key={cf.path} className="activity-context-item">
                      <span className="activity-context-path" title={cf.path}>
                        {cf.path.split(/[/\\]/).pop() ?? cf.path}
                      </span>
                      <span className="activity-context-type">{cf.memoryType}</span>
                    </div>
                  ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
