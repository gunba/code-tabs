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

const MAX_TURNS = 50;
const MAX_ALL_FILES = 500;
const CONFIRM_WINDOW_MS = 2000;

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
      permissionMode?: string | null;
      toolInputData?: ToolInputDiffData | null;
    },
  ) => void;
  confirmFileChange: (sessionId: string, path: string) => void;
  markPermissionDenied: (sessionId: string, path: string) => void;
  addContextFile: (sessionId: string, entry: ContextFileEntry) => void;
  clearSession: (sessionId: string) => void;
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
      if (f.kind !== "read") {
        activity.allFiles[f.path] = f;
      }
    }
  }
  // Evict oldest allFiles entries if over cap
  const entries = Object.entries(activity.allFiles);
  if (entries.length > MAX_ALL_FILES) {
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.length - MAX_ALL_FILES;
    for (let i = 0; i < toRemove; i++) {
      delete activity.allFiles[entries[i][0]];
    }
  }
}

function recomputeStats(activity: SessionActivity): void {
  // Merge current turn files + allFiles for stats
  const merged: Record<string, FileActivity> = { ...activity.allFiles };
  for (const turn of activity.turns) {
    for (const f of turn.files) {
      if (f.kind !== "read") {
        merged[f.path] = f;
      }
    }
  }
  activity.stats = computeStats(merged);
}

export const useActivityStore = create<ActivityState>()((set) => ({
  sessions: {},

  startTurn: (sessionId, turnId) =>
    set((state) => {
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
      return { sessions };
    }),

  endTurn: (sessionId) =>
    set((state) => {
      const sessions = { ...state.sessions };
      const activity = sessions[sessionId];
      if (!activity) return state;
      const turn = currentTurn(activity);
      if (turn && turn.endedAt === null) {
        turn.endedAt = Date.now();
      }
      recomputeStats(activity);
      return { sessions };
    }),

  addFileActivity: (sessionId, path, kind, opts) =>
    set((state) => {
      const sessions = { ...state.sessions };
      const activity = ensureSession(sessions, sessionId);
      const entry: FileActivity = {
        path,
        kind,
        agentId: opts?.agentId ?? null,
        toolName: opts?.toolName ?? null,
        timestamp: Date.now(),
        confirmed: kind === "read",
        isExternal: opts?.isExternal ?? false,
        permissionDenied: false,
        permissionMode: opts?.permissionMode ?? null,
        toolInputData: opts?.toolInputData ?? null,
      };
      const turn = currentTurn(activity);
      if (turn && turn.endedAt === null) {
        // Deduplicate: update existing entry for same path in current turn
        const existing = turn.files.findIndex((f) => f.path === path);
        if (existing >= 0) {
          // Keep the more significant kind (write > read)
          if (kind !== "read" || turn.files[existing].kind === "read") {
            turn.files[existing] = entry;
          }
        } else {
          turn.files.push(entry);
        }
      }
      // Also update allFiles for non-read operations
      if (kind !== "read") {
        activity.allFiles[path] = entry;
      }
      recomputeStats(activity);
      return { sessions };
    }),

  confirmFileChange: (sessionId, path) =>
    set((state) => {
      const sessions = { ...state.sessions };
      const activity = sessions[sessionId];
      if (!activity) return state;
      const turn = currentTurn(activity);
      if (!turn) return state;

      // Find unconfirmed entry in current turn within the confirmation window
      const now = Date.now();
      const idx = turn.files.findIndex(
        (f) =>
          f.path === path &&
          !f.confirmed &&
          now - f.timestamp < CONFIRM_WINDOW_MS,
      );
      if (idx >= 0) {
        turn.files[idx] = { ...turn.files[idx], confirmed: true };
      }
      return { sessions };
    }),

  markPermissionDenied: (sessionId, path) =>
    set((state) => {
      const sessions = { ...state.sessions };
      const activity = sessions[sessionId];
      if (!activity) return state;
      const turn = currentTurn(activity);
      if (!turn) return state;
      const idx = turn.files.findIndex((f) => f.path === path);
      if (idx >= 0) {
        turn.files[idx] = { ...turn.files[idx], permissionDenied: true };
      }
      return { sessions };
    }),

  addContextFile: (sessionId, entry) =>
    set((state) => {
      const sessions = { ...state.sessions };
      const activity = ensureSession(sessions, sessionId);
      if (!activity.contextFiles.some((c) => c.path === entry.path)) {
        activity.contextFiles.push(entry);
      }
      return { sessions };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    }),
}));
