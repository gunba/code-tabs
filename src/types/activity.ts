export type FileChangeKind = "created" | "modified" | "deleted" | "renamed" | "read" | "searched";

export interface FileActivity {
  path: string;
  kind: FileChangeKind;
  agentId: string | null;
  toolName: string | null;
  timestamp: number;
  confirmed: boolean;
  isExternal: boolean;
  permissionDenied: boolean;
  permissionMode: string | null;
  /** For Edit: old_string/new_string from ToolInput. For Write: content from ToolInput. */
  toolInputData: ToolInputDiffData | null;
  /** True when this activity targets a folder (e.g., Grep/Glob searching a directory). */
  isFolder: boolean;
}

/** Data captured from ToolInput events for on-demand diff construction. */
export type ToolInputDiffData =
  | { type: "edit"; oldString: string; newString: string }
  | { type: "write"; content: string };

export type ViewMode = "response" | "session";

export interface TurnActivity {
  turnId: string;
  startedAt: number;
  endedAt: number | null;
  files: FileActivity[];
}

export interface SessionActivity {
  turns: TurnActivity[];
  allFiles: Record<string, FileActivity>;
  /** Every unique file path the agent has touched this session (reads included). */
  visitedPaths: Set<string>;
  /** Timestamp of the last committed response-boundary event for Response mode. */
  lastUserMessageAt: number;
  contextFiles: ContextFileEntry[];
  stats: ActivityStats;
  /** Persisted collapsed/expanded folder paths for the activity tree. */
  expandedPaths: Set<string>;
  /** Folder paths that have been observed at least once; used to scope auto-expand
   *  to genuinely new folders so user collapses on already-seen folders aren't undone. */
  seenFolderPaths: Set<string>;
  /** Persisted view mode toggle (Response vs Session). */
  viewMode: ViewMode;
}

export interface ActivityStats {
  filesModified: number;
  filesCreated: number;
  filesDeleted: number;
  filesRead: number;
  filesSearched: number;
}

export interface ContextFileEntry {
  path: string;
  memoryType: string;
  loadReason: string;
}

export function emptySessionActivity(): SessionActivity {
  return {
    turns: [],
    allFiles: {},
    visitedPaths: new Set(),
    lastUserMessageAt: 0,
    contextFiles: [],
    stats: { filesModified: 0, filesCreated: 0, filesDeleted: 0, filesRead: 0, filesSearched: 0 },
    expandedPaths: new Set(),
    seenFolderPaths: new Set(),
    viewMode: "response",
  };
}

export function computeStats(files: Record<string, FileActivity>): ActivityStats {
  const stats: ActivityStats = { filesModified: 0, filesCreated: 0, filesDeleted: 0, filesRead: 0, filesSearched: 0 };
  for (const f of Object.values(files)) {
    if (f.permissionDenied) continue;
    switch (f.kind) {
      case "modified": stats.filesModified++; break;
      case "created": stats.filesCreated++; break;
      case "deleted": stats.filesDeleted++; break;
      case "read": stats.filesRead++; break;
      case "searched": stats.filesSearched++; break;
    }
  }
  return stats;
}
