export type FileChangeKind = "created" | "modified" | "deleted" | "renamed" | "read";

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
}

/** Data captured from ToolInput events for on-demand diff construction. */
export type ToolInputDiffData =
  | { type: "edit"; oldString: string; newString: string }
  | { type: "write"; content: string };

export interface TurnActivity {
  turnId: string;
  startedAt: number;
  endedAt: number | null;
  files: FileActivity[];
}

export interface SessionActivity {
  turns: TurnActivity[];
  allFiles: Record<string, FileActivity>;
  contextFiles: ContextFileEntry[];
  stats: ActivityStats;
}

export interface ActivityStats {
  filesModified: number;
  filesCreated: number;
  filesDeleted: number;
  filesRead: number;
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
    contextFiles: [],
    stats: { filesModified: 0, filesCreated: 0, filesDeleted: 0, filesRead: 0 },
  };
}

export function computeStats(files: Record<string, FileActivity>): ActivityStats {
  const stats: ActivityStats = { filesModified: 0, filesCreated: 0, filesDeleted: 0, filesRead: 0 };
  for (const f of Object.values(files)) {
    if (f.permissionDenied) continue;
    switch (f.kind) {
      case "modified": stats.filesModified++; break;
      case "created": stats.filesCreated++; break;
      case "deleted": stats.filesDeleted++; break;
      case "read": stats.filesRead++; break;
    }
  }
  return stats;
}
