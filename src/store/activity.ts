import { create } from "zustand";
import type {
  FileActivity,
  TurnActivity,
  SessionActivity,
  ContextFileEntry,
  FileChangeKind,
  ToolInputDiffData,
} from "../types/activity";
import { emptySessionActivity, computeStats } from "../types/activity";
import { traceSync } from "../lib/perfTrace";

const MAX_TURNS = 50;
const MAX_ALL_FILES = 500;

interface ActivityState {
  sessions: Record<string, SessionActivity>;

  startTurn: (sessionId: string, turnId: string) => void;
  endTurn: (sessionId: string) => void;
  addFileActivity: (
    sessionId: string,
    path: string,
    kind: FileChangeKind,
    opts?: {
      agentId?: string | null;
      toolName?: string | null;
      isExternal?: boolean;
      isFolder?: boolean;
      permissionMode?: string | null;
      toolInputData?: ToolInputDiffData | null;
    },
  ) => void;
  markPermissionDenied: (sessionId: string, path: string) => void;
  markUserMessage: (sessionId: string) => void;
  addContextFile: (sessionId: string, entry: ContextFileEntry) => void;
  clearSession: (sessionId: string) => void;
  clearAgentSearchActivity: (sessionId: string, agentId: string) => void;
  toggleExpandedPath: (sessionId: string, path: string) => void;
  mergeExpandedPaths: (sessionId: string, paths: Iterable<string>) => void;
}

function ensureSession(
  sessions: Record<string, SessionActivity>,
  sessionId: string,
): SessionActivity {
  if (!sessions[sessionId]) {
    sessions[sessionId] = emptySessionActivity();
  }
  return sessions[sessionId];
}

function currentTurn(activity: SessionActivity): TurnActivity | undefined {
  return activity.turns.length > 0
    ? activity.turns[activity.turns.length - 1]
    : undefined;
}

function evictOldTurns(activity: SessionActivity): void {
  while (activity.turns.length > MAX_TURNS) {
    const evicted = activity.turns.shift()!;
    for (const f of evicted.files) {
      activity.allFiles[f.path] = f;
    }
  }
  // Evict oldest allFiles entries if over cap
  const entries = Object.entries(activity.allFiles);
  if (entries.length > MAX_ALL_FILES) {
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.length - MAX_ALL_FILES;
    for (let i = 0; i < toRemove; i++) {
      delete activity.allFiles[entries[i][0]];
      activity.visitedPaths.delete(entries[i][0]);
    }
  }
}

function recomputeStats(activity: SessionActivity): void {
  // Merge current turn files + allFiles for stats
  const merged: Record<string, FileActivity> = { ...activity.allFiles };
  for (const turn of activity.turns) {
    for (const f of turn.files) {
      if (f.kind !== "read" && f.kind !== "searched") {
        merged[f.path] = f;
      }
    }
  }
  activity.stats = computeStats(merged);
}

export const useActivityStore = create<ActivityState>()((set) => ({
  sessions: {},

  startTurn: (sessionId, turnId) =>
    set((state) => traceSync("activity.start_turn", () => {
      const sessions = { ...state.sessions };
      const activity = ensureSession(sessions, sessionId);
      // End previous turn if still open
      const prev = currentTurn(activity);
      if (prev && prev.endedAt === null) {
        prev.endedAt = Date.now();
      }
      activity.turns.push({
        turnId,
        startedAt: Date.now(),
        endedAt: null,
        files: [],
      });
      evictOldTurns(activity);
      sessions[sessionId] = { ...activity };
      return { sessions };
    }, {
      module: "activity",
      sessionId,
      event: "activity.start_turn",
      warnAboveMs: 8,
      data: { turnId },
    })),

  endTurn: (sessionId) =>
    set((state) => traceSync("activity.end_turn", () => {
      const sessions = { ...state.sessions };
      const activity = sessions[sessionId];
      if (!activity) return state;
      const turn = currentTurn(activity);
      if (turn && turn.endedAt === null) {
        turn.endedAt = Date.now();
      }
      recomputeStats(activity);
      sessions[sessionId] = { ...activity };
      return { sessions };
    }, {
      module: "activity",
      sessionId,
      event: "activity.end_turn",
      warnAboveMs: 8,
      data: {},
    })),

  addFileActivity: (sessionId, path, kind, opts) =>
    set((state) => traceSync("activity.add_file", () => {
      const sessions = { ...state.sessions };
      const activity = ensureSession(sessions, sessionId);
      const entry: FileActivity = {
        path,
        kind,
        agentId: opts?.agentId ?? null,
        toolName: opts?.toolName ?? null,
        timestamp: Date.now(),
        confirmed: true,
        isExternal: opts?.isExternal ?? false,
        permissionDenied: false,
        permissionMode: opts?.permissionMode ?? null,
        toolInputData: opts?.toolInputData ?? null,
        isFolder: opts?.isFolder ?? false,
      };
      const turn = currentTurn(activity);
      if (turn && turn.endedAt === null) {
        // Deduplicate: update existing entry for same path in current turn
        const existing = turn.files.findIndex((f) => f.path === path);
        if (existing >= 0) {
          // [AP-03] Kind precedence: created > modified > read > searched; never downgrade
          // "searched" is lowest: never overwrites any existing kind
          if (kind === "searched" && turn.files[existing].kind !== "searched") {
            // Don't downgrade — skip
          } else if (kind !== "read" || turn.files[existing].kind === "read" || turn.files[existing].kind === "searched") {
            if (turn.files[existing].kind === "created" && kind === "modified") {
              entry.kind = "created";
            }
            turn.files[existing] = entry;
          }
        } else {
          turn.files.push(entry);
        }
      }
      // Track in session-wide indices — preserve "created" over "modified", and any real kind over "searched"
      activity.visitedPaths.add(path);
      const prev = activity.allFiles[path];
      if (prev?.kind === "created" && entry.kind === "modified") {
        entry.kind = "created";
      }
      // Don't downgrade from a real kind to "searched"
      if (entry.kind === "searched" && prev && prev.kind !== "searched") {
        // Keep prev in allFiles, but still update agentId/timestamp for mascot tracking
        activity.allFiles[path] = { ...prev, agentId: entry.agentId, timestamp: entry.timestamp };
      } else {
        activity.allFiles[path] = entry;
      }
      recomputeStats(activity);
      sessions[sessionId] = { ...activity };
      return { sessions };
    }, {
      module: "activity",
      sessionId,
      event: "activity.add_file",
      warnAboveMs: 8,
      data: {
        path,
        kind,
        toolName: opts?.toolName ?? null,
        agentId: opts?.agentId ?? null,
        isExternal: opts?.isExternal ?? false,
      },
    })),

  markPermissionDenied: (sessionId, path) =>
    set((state) => traceSync("activity.permission_denied", () => {
      const sessions = { ...state.sessions };
      const activity = sessions[sessionId];
      if (!activity) return state;
      const turn = currentTurn(activity);
      if (!turn) return state;
      const idx = turn.files.findIndex((f) => f.path === path);
      if (idx >= 0) {
        turn.files[idx] = { ...turn.files[idx], permissionDenied: true };
      }
      sessions[sessionId] = { ...activity };
      return { sessions };
    }, {
      module: "activity",
      sessionId,
      event: "activity.permission_denied",
      warnAboveMs: 8,
      data: { path },
    })),

  markUserMessage: (sessionId) =>
    set((state) => traceSync("activity.mark_user_message", () => {
      const sessions = { ...state.sessions };
      const activity = ensureSession(sessions, sessionId);
      activity.lastUserMessageAt = Date.now();
      sessions[sessionId] = { ...activity };
      return { sessions };
    }, {
      module: "activity",
      sessionId,
      event: "activity.mark_user_message",
      warnAboveMs: 8,
      data: {},
    })),

  addContextFile: (sessionId, entry) =>
    set((state) => traceSync("activity.add_context_file", () => {
      const sessions = { ...state.sessions };
      const activity = ensureSession(sessions, sessionId);
      if (!activity.contextFiles.some((c) => c.path === entry.path)) {
        activity.contextFiles.push(entry);
      }
      activity.visitedPaths.add(entry.path);
      sessions[sessionId] = { ...activity };
      return { sessions };
    }, {
      module: "activity",
      sessionId,
      event: "activity.add_context_file",
      warnAboveMs: 8,
      data: {
        path: entry.path,
        memoryType: entry.memoryType,
        loadReason: entry.loadReason,
      },
    })),

  clearSession: (sessionId) =>
    set((state) => traceSync("activity.clear_session", () => {
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    }, {
      module: "activity",
      sessionId,
      event: "activity.clear_session",
      warnAboveMs: 8,
      data: {},
    })),

  clearAgentSearchActivity: (sessionId, agentId) =>
    set((state) => traceSync("activity.clear_agent_search", () => {
      const activity = state.sessions[sessionId];
      if (!activity) return state;
      let changed = false;
      const nextTurns: TurnActivity[] = [];
      for (const turn of activity.turns) {
        const filtered = turn.files.filter(
          (f) => !(f.kind === "searched" && f.agentId === agentId && f.isFolder === true),
        );
        if (filtered.length !== turn.files.length) {
          changed = true;
          nextTurns.push({ ...turn, files: filtered });
        } else {
          nextTurns.push(turn);
        }
      }
      const nextAllFiles: Record<string, FileActivity> = {};
      for (const [key, entry] of Object.entries(activity.allFiles)) {
        if (entry.kind === "searched" && entry.agentId === agentId && entry.isFolder === true) {
          changed = true;
        } else {
          nextAllFiles[key] = entry;
        }
      }
      if (!changed) return state;
      const nextActivity: SessionActivity = {
        ...activity,
        turns: nextTurns,
        allFiles: nextAllFiles,
      };
      recomputeStats(nextActivity);
      return { sessions: { ...state.sessions, [sessionId]: nextActivity } };
    }, {
      module: "activity",
      sessionId,
      event: "activity.clear_agent_search",
      warnAboveMs: 8,
      data: { agentId },
    })),

  toggleExpandedPath: (sessionId, path) =>
    set((state) => {
      const sessions = { ...state.sessions };
      const activity = sessions[sessionId];
      if (!activity) return state;
      const next = new Set(activity.expandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      sessions[sessionId] = { ...activity, expandedPaths: next };
      return { sessions };
    }),

  // [AS-02] mergeExpandedPaths auto-expands only folders not in seenFolderPaths; preserves user collapses
  mergeExpandedPaths: (sessionId, paths) =>
    set((state) => {
      const sessions = { ...state.sessions };
      const activity = sessions[sessionId];
      if (!activity) return state;
      let changed = false;
      const nextExpanded = new Set(activity.expandedPaths);
      const nextSeen = new Set(activity.seenFolderPaths);
      for (const p of paths) {
        // Only auto-expand folders we've never seen before — this preserves
        // user collapses on already-seen folders across tree refreshes.
        if (!nextSeen.has(p)) {
          nextSeen.add(p);
          nextExpanded.add(p);
          changed = true;
        }
      }
      if (!changed) return state;
      sessions[sessionId] = {
        ...activity,
        expandedPaths: nextExpanded,
        seenFolderPaths: nextSeen,
      };
      return { sessions };
    }),

}));
