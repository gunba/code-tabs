import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useActivityStore } from "../../store/activity";
import { useSessionStore } from "../../store/sessions";
import { ClaudeMascot } from "./ClaudeMascot";
import type { MascotState } from "./ClaudeMascot";
import { IconClose, IconFolder, IconDocument } from "../Icons/Icons";
import { isSubagentActive } from "../../types/session";
import type { FileActivity, ContextFileEntry } from "../../types/activity";
import { buildFileTree, flattenTree, allFolderPaths } from "../../lib/fileTree";
import type { FileTreeNode } from "../../lib/fileTree";
import "./ActivityPanel.css";

interface ActivityPanelProps {
  onClose: () => void;
}

type ViewMode = "response" | "session";

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

interface AgentOnFile {
  toolName: string;
  isSubagent: boolean;
  agentId: string | null;
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

/* -- Tree row component -- */

function FileTreeRow({
  node,
  depth,
  isExpanded,
  onToggle,
  agents,
  contextInfo,
  onFileClick,
}: {
  node: FileTreeNode;
  depth: number;
  isExpanded: boolean;
  onToggle: (path: string) => void;
  agents: AgentOnFile[];
  contextInfo: ContextFileEntry | null;
  onFileClick: (path: string) => void;
}) {
  const indent = depth * 16;
  const primaryMascot = agents.length > 0 ? agents[0] : null;
  const extraAgentCount = agents.length > 1 ? agents.length - 1 : 0;
  const mascotState = primaryMascot ? toolToMascotState(primaryMascot.toolName) : null;

  const tooltip = contextInfo
    ? `${node.fullPath}\nContext: ${contextInfo.memoryType} (${contextInfo.loadReason})`
    : node.fullPath;

  if (node.isFile) {
    return (
      <div
        className="file-tree-row file-tree-file"
        style={{ paddingLeft: indent + 4 }}
        onClick={() => onFileClick(node.fullPath)}
        title={tooltip}
      >
        <span className="file-tree-icon-slot">
          {mascotState ? (
            <ClaudeMascot
              state={mascotState}
              isSubagent={primaryMascot?.isSubagent}
              size={16}
            />
          ) : (
            <IconDocument size={14} />
          )}
        </span>
        <span className="file-tree-name file-tree-filename">{node.name}</span>
        {extraAgentCount > 0 && (
          <span className="file-tree-agent-count">+{extraAgentCount}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className="file-tree-row file-tree-folder"
      style={{ paddingLeft: indent }}
      onClick={() => onToggle(node.fullPath)}
      title={node.fullPath}
    >
      <span className={`file-tree-chevron${isExpanded ? "" : " collapsed"}`}>
        {"\u25BE"}
      </span>
      <span className="file-tree-icon-slot">
        <IconFolder size={14} />
      </span>
      <span className="file-tree-name file-tree-foldername">{node.name}</span>
    </div>
  );
}

/* -- Main panel -- */

export function ActivityPanel({ onClose }: ActivityPanelProps) {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const sessions = useSessionStore((s) => s.sessions);
  const storeSubagents = useSessionStore((s) => s.subagents);
  const activeSession = sessions.find((s) => s.id === activeTabId);

  const activity = useActivityStore((s) => activeTabId ? s.sessions[activeTabId] ?? null : null);

  const [mode, setMode] = useState<ViewMode>("response");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  // Reset on session switch
  useEffect(() => {
    setExpandedPaths(new Set());
  }, [activeTabId]);

  // Build map of file paths currently being worked on by agents (supports multiple per path)
  const activeAgentFiles = useMemo(() => {
    const map = new Map<string, AgentOnFile[]>();
    if (!activeSession) return map;

    const pushAgent = (path: string, agent: AgentOnFile) => {
      const existing = map.get(path);
      if (existing) {
        existing.push(agent);
      } else {
        map.set(path, [agent]);
      }
    };

    // Main agent
    const meta = activeSession.metadata;
    if (meta.currentAction && meta.currentToolName && FILE_TOOLS.has(meta.currentToolName)) {
      const path = extractPathFromAction(meta.currentAction);
      if (path) {
        pushAgent(path, { toolName: meta.currentToolName, isSubagent: false, agentId: null });
      }
    }

    // Subagents
    const subs = activeTabId ? storeSubagents.get(activeTabId) ?? [] : [];
    for (const sub of subs) {
      if (!isSubagentActive(sub.state)) continue;
      if (sub.currentAction && sub.currentToolName && FILE_TOOLS.has(sub.currentToolName)) {
        const path = extractPathFromAction(sub.currentAction);
        if (path) {
          pushAgent(path, { toolName: sub.currentToolName, isSubagent: true, agentId: sub.id });
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

  // Build context file lookup by path
  const contextFileMap = useMemo(() => {
    const map = new Map<string, ContextFileEntry>();
    if (!activity) return map;
    for (const cf of activity.contextFiles) {
      map.set(cf.path, cf);
    }
    return map;
  }, [activity?.contextFiles]);

  // Derive the file set based on mode
  const fileMap = useMemo(() => {
    const map = new Map<string, FileActivity>();
    if (!activity) return map;

    if (mode === "response") {
      // Files from turns since the last user message.
      // boundary=0 before first message → show all turns (session start).
      // After first message: TurnStart fires after UserInput in the TAP event stream.
      const boundary = activity.lastUserMessageAt;
      for (const turn of activity.turns) {
        if (turn.startedAt >= boundary) {
          for (const f of turn.files) {
            map.set(f.path, f);
          }
        }
      }
    } else {
      // Session mode: all visited paths resolved against allFiles
      for (const path of activity.visitedPaths) {
        const entry = activity.allFiles[path];
        if (entry) {
          map.set(path, entry);
        } else {
          // Path was visited but evicted from allFiles — create a synthetic entry
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
          });
        }
      }
    }

    return map;
  }, [activity, mode]);

  // Build the tree
  const tree = useMemo(() => buildFileTree(fileMap), [fileMap]);

  // Auto-expand new folders when tree changes
  useEffect(() => {
    if (tree.length === 0) return;
    const newFolders = allFolderPaths(tree);
    setExpandedPaths((prev) => {
      const merged = new Set(prev);
      for (const path of newFolders) {
        merged.add(path);
      }
      return merged;
    });
  }, [tree]);

  // Flatten for rendering
  const rows = useMemo(() => flattenTree(tree, expandedPaths), [tree, expandedPaths]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleFileClick = useCallback((filePath: string) => {
    invoke("shell_open", { path: filePath }).catch(() => {});
  }, []);

  if (!activeSession) return <EmptyPanel onClose={onClose} message="No active session" />;
  if (activeSession.state === "dead") return <EmptyPanel onClose={onClose} message="Session ended" />;

  return (
    <div className="activity-panel">
      <div className="activity-panel-header">
        <span className="activity-panel-title">Activity</span>
        <div className="activity-mode-toggle">
          <button
            className={`activity-mode-btn${mode === "response" ? " active" : ""}`}
            onClick={() => setMode("response")}
          >
            Response
          </button>
          <button
            className={`activity-mode-btn${mode === "session" ? " active" : ""}`}
            onClick={() => setMode("session")}
          >
            Session
          </button>
        </div>
        <span className="activity-panel-spacer" />
        <button className="activity-panel-close" onClick={onClose} title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>

      <div className="activity-panel-body">
        {rows.length === 0 ? (
          <div className="activity-panel-empty">
            {mode === "response" ? "No activity yet" : "No files visited"}
          </div>
        ) : (
          rows.map((row) => (
            <FileTreeRow
              key={row.key}
              node={row.node}
              depth={row.depth}
              isExpanded={expandedPaths.has(row.node.fullPath)}
              onToggle={toggleFolder}
              agents={activeAgentFiles.get(row.node.fullPath) ?? []}
              contextInfo={row.node.isFile ? contextFileMap.get(row.node.fullPath) ?? null : null}
              onFileClick={handleFileClick}
            />
          ))
        )}
      </div>
    </div>
  );
}
