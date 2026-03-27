import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { trace, traceAsync } from "../lib/perfTrace";
import { assignSessionColor, releaseSessionColor } from "../lib/claude";
import { dlog } from "../lib/debugLog";
import type {
  Session,
  SessionConfig,
  SessionState,
  SessionMetadata,
  Subagent,
} from "../types/session";

interface SessionsState {
  sessions: Session[];
  activeTabId: string | null;
  claudePath: string | null;
  initialized: boolean;
  subagents: Map<string, Subagent[]>; // sessionId -> subagents
  commandHistory: Map<string, string[]>; // sessionId -> commands (newest first)
  respawnRequest: { tabId: string; config: SessionConfig; name?: string } | null;
  killRequest: string | null; // sessionId to kill
  hookChangeCounter: number;
  inspectorOffSessions: Set<string>;
  tapCategories: Map<string, Set<string>>; // sessionId -> enabled tap category names
  processHealth: Map<string, { rss: number; heapUsed: number; uptime: number }>;

  // Actions
  init: () => Promise<void>;
  createSession: (name: string, config: SessionConfig, opts?: { isMetaAgent?: boolean; insertAtIndex?: number }) => Promise<Session>;
  closeSession: (id: string) => Promise<void>;
  setActiveTab: (id: string) => void;
  updateState: (id: string, state: SessionState) => void;
  updateMetadata: (id: string, metadata: Partial<SessionMetadata>) => void;
  updateConfig: (id: string, config: Partial<SessionConfig>) => void;
  reorderTabs: (order: string[]) => void;
  persist: () => Promise<void>;
  renameSession: (id: string, name: string) => void;
  setUserRenamed: (id: string, value: boolean) => void;
  requestRespawn: (tabId: string, config: SessionConfig, name?: string) => void;
  clearRespawnRequest: () => void;
  requestKill: (id: string) => void;
  clearKillRequest: () => void;
  bumpHookChange: () => void;
  setInspectorOff: (id: string, off: boolean) => void;
  toggleTapCategory: (id: string, category: string) => void;
  startAllTaps: (id: string) => void;
  stopAllTaps: (id: string) => void;
  addSubagent: (sessionId: string, subagent: Subagent) => void;
  updateSubagent: (sessionId: string, subagentId: string, updates: Partial<Subagent>) => void;
  clearIdleSubagents: (sessionId: string) => void;
  addCommandHistory: (sessionId: string, command: string) => void;
  updateProcessHealth: (id: string, data: { rss: number; heapUsed: number; uptime: number }) => void;
}

export const useSessionStore = create<SessionsState>((set) => ({
  sessions: [],
  activeTabId: null,
  claudePath: null,
  initialized: false,
  subagents: new Map(),
  commandHistory: new Map(),
  respawnRequest: null,
  killRequest: null,
  hookChangeCounter: 0,
  inspectorOffSessions: new Set(),
  tapCategories: new Map(),
  processHealth: new Map(),

  init: async () => {
    trace("init: start");
    let sessions: Session[] = [];
    try {
      sessions = await traceAsync("init: load_persisted_sessions", () =>
        invoke<Session[]>("load_persisted_sessions")
      );
      // Assign colors sequentially to restored sessions
      const allIds = sessions.map((s) => s.id);
      for (const s of sessions) {
        assignSessionColor(s.id, allIds);
      }
      set({ sessions, activeTabId: null, initialized: true });
      trace("init: sessions set, initialized=true");
    } catch {
      set({ initialized: true });
      trace("init: no sessions, initialized=true");
    }
    // Collect all session IDs for orphan cleanup
    const sessionIds = new Set<string>();
    for (const s of sessions) {
      if (s.config.sessionId) sessionIds.add(s.config.sessionId);
      if (s.config.resumeSession) sessionIds.add(s.config.resumeSession);
    }
    // Kill orphan processes and detect CLI in parallel — both must
    // complete before claudePath is set (which gates PTY spawning)
    const [claudePath] = await Promise.all([
      traceAsync("init: detect_claude_cli", () => invoke<string>("detect_claude_cli"))
        .catch((e) => { dlog("session", null, `CLI detection failed: ${e}`, "ERR"); return null as string | null; }),
      sessionIds.size > 0
        ? traceAsync("init: kill_orphan_sessions", () =>
            invoke<number>("kill_orphan_sessions", { sessionIds: [...sessionIds] })
          ).then((n) => { if (n > 0) trace(`init: killed ${n} orphan(s)`); })
           .catch((e) => dlog("session", null, `orphan cleanup failed: ${e}`, "ERR"))
        : Promise.resolve(),
    ]);
    if (claudePath) {
      set({ claudePath });
      trace("init: claudePath set");
    }
  },

  createSession: async (name, config, opts = {}) => {
    const session = await invoke<Session>("create_session", { name, config });
    const tagged = {
      ...session,
      isMetaAgent: opts.isMetaAgent ?? false,
    };
    // Assign a color to the new session, avoiding colors of existing sessions
    const existingIds = useSessionStore.getState().sessions.map((s) => s.id);
    assignSessionColor(tagged.id, existingIds);
    set((s) => {
      let sessions;
      if (opts.insertAtIndex !== undefined && opts.insertAtIndex >= 0) {
        // Revival: insert at the original position to preserve ordering
        sessions = [...s.sessions];
        sessions.splice(opts.insertAtIndex, 0, tagged);
      } else if (opts.isMetaAgent) {
        sessions = [tagged, ...s.sessions];
      } else {
        sessions = [...s.sessions, tagged];
      }
      return { sessions, activeTabId: tagged.id };
    });
    return tagged;
  },

  closeSession: async (id) => {
    // Remove from UI immediately — store-first, matching setActiveTab/reorderTabs.
    // The IPC notification is best-effort; the frontend owns persistence.
    releaseSessionColor(id);
    set((s) => {
      const closedIndex = s.sessions.findIndex((x) => x.id === id);
      const sessions = s.sessions.filter((x) => x.id !== id);
      let activeTabId: string | null;
      if (s.activeTabId !== id) {
        activeTabId = s.activeTabId;
      } else {
        // Prefer tab to the right (same index after removal), then left
        activeTabId = sessions[closedIndex]?.id ?? sessions[closedIndex - 1]?.id ?? null;
      }
      const subagents = new Map(s.subagents);
      subagents.delete(id);
      const commandHistory = new Map(s.commandHistory);
      commandHistory.delete(id);
      const inspectorOffSessions = new Set(s.inspectorOffSessions);
      inspectorOffSessions.delete(id);
      const tapCategories = new Map(s.tapCategories);
      tapCategories.delete(id);
      const processHealth = new Map(s.processHealth);
      processHealth.delete(id);
      return { sessions, activeTabId, subagents, commandHistory, inspectorOffSessions, tapCategories, processHealth };
    });
    // Persist immediately so the removal is captured even if the app closes
    useSessionStore.getState().persist();
    // Notify backend (best-effort, fire-and-forget)
    invoke("close_session", { id }).catch((err) =>
      dlog("session", id, `close_session IPC failed: ${err}`, "WARN")
    );
  },

  setActiveTab: (id) => {
    invoke("set_active_tab", { id });
    set({ activeTabId: id });
  },

  updateState: (id, state) => {
    const prev = useSessionStore.getState().sessions.find((x) => x.id === id);
    if (prev && prev.state !== state) {
      dlog("session", id, `state ${prev.state} → ${state}`, "DEBUG");
    }
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, state } : x
      ),
    }));
  },

  updateMetadata: (id, metadata) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, metadata: { ...x.metadata, ...metadata } } : x
      ),
    }));
  },

  updateConfig: (id, config) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, config: { ...x.config, ...config } } : x
      ),
    }));
  },

  reorderTabs: (order) => {
    invoke("reorder_tabs", { order });
    set((s) => {
      const map = new Map(s.sessions.map((x) => [x.id, x]));
      const orderSet = new Set(order);
      const reordered = order.map((id) => map.get(id)!).filter(Boolean);
      const rest = s.sessions.filter((x) => !orderSet.has(x.id));
      return { sessions: [...reordered, ...rest] };
    });
  },

  persist: async () => {
    // Serialize from the frontend store (not the Rust session manager)
    // because the Rust side doesn't receive metadata updates.
    // All sessions are persisted as "dead" — on reload, they can't have
    // running PTYs, so active states (thinking/toolUse) would be stale.
    const snapshots = useSessionStore.getState().sessions.map((s) => ({
      id: s.id,
      name: s.name,
      config: s.config,
      state: "dead" as const,
      metadata: s.metadata,
      createdAt: s.createdAt,
      lastActive: s.lastActive,
    }));
    await invoke("persist_sessions_json", {
      json: JSON.stringify(snapshots, null, 2),
    });
  },

  renameSession: (id, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, name } : x
      ),
    }));
  },

  setUserRenamed: (id, value) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, userRenamed: value } : x
      ),
    }));
  },

  requestRespawn: (tabId, config, name) => {
    set({ respawnRequest: { tabId, config, name } });
  },

  clearRespawnRequest: () => {
    set({ respawnRequest: null });
  },

  requestKill: (id) => {
    set({ killRequest: id });
  },

  clearKillRequest: () => {
    set({ killRequest: null });
  },

  bumpHookChange: () => {
    set((s) => ({ hookChangeCounter: s.hookChangeCounter + 1 }));
  },

  setInspectorOff: (id, off) => {
    set((s) => {
      const next = new Set(s.inspectorOffSessions);
      if (off) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return { inspectorOffSessions: next };
    });
  },

  toggleTapCategory: (id, category) => {
    set((s) => {
      const next = new Map(s.tapCategories);
      const cats = new Set(next.get(id) || []);
      if (cats.has(category)) {
        cats.delete(category);
      } else {
        cats.add(category);
      }
      if (cats.size === 0) {
        next.delete(id);
      } else {
        next.set(id, cats);
      }
      return { tapCategories: next };
    });
  },

  startAllTaps: (id) => {
    set((s) => {
      const next = new Map(s.tapCategories);
      next.set(id, new Set(["parse", "stringify", "console", "fs", "spawn", "fetch", "exit", "timer", "stdout", "stderr", "require", "bun"]));
      return { tapCategories: next };
    });
  },

  stopAllTaps: (id) => {
    set((s) => {
      const next = new Map(s.tapCategories);
      next.delete(id);
      return { tapCategories: next };
    });
  },

  addSubagent: (sessionId, subagent) => {
    set((s) => {
      const map = new Map(s.subagents);
      const existing = map.get(sessionId) || [];
      // Don't add duplicates
      if (existing.some((sa) => sa.id === subagent.id)) return s;
      map.set(sessionId, [subagent, ...existing]);
      return { subagents: map };
    });
  },

  updateSubagent: (sessionId, subagentId, updates) => {
    set((s) => {
      const map = new Map(s.subagents);
      const list = map.get(sessionId);
      if (!list) return s;
      const updated = list.map((sa) =>
        sa.id === subagentId ? { ...sa, ...updates } : sa
      );
      map.set(sessionId, updated);
      return { subagents: map };
    });
  },

  clearIdleSubagents: (sessionId) => {
    set((s) => {
      const map = new Map(s.subagents);
      const list = map.get(sessionId);
      if (!list) return s;
      const active = list.filter((sa) => sa.state !== "idle" && sa.state !== "interrupted");
      if (active.length === list.length) return s;
      map.set(sessionId, active);
      return { subagents: map };
    });
  },

  addCommandHistory: (sessionId, command) => {
    set((s) => {
      const map = new Map(s.commandHistory);
      const existing = map.get(sessionId) || [];
      const updated = [command, ...existing];
      map.set(sessionId, updated.length > 50 ? updated.slice(0, 50) : updated);
      return { commandHistory: map };
    });
  },

  updateProcessHealth: (id, data) => {
    set((s) => {
      const next = new Map(s.processHealth);
      next.set(id, data);
      return { processHealth: next };
    });
  },
}));
