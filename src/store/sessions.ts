import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { trace, traceAsync } from "../lib/perfTrace";
import { assignSessionColor, releaseSessionColor, findNearestLiveTab } from "../lib/claude";
import { fetchAnthropicModelCatalog } from "../lib/modelCatalog";
import { useActivityStore } from "./activity";
import { dlog, removeDebugLogSession } from "../lib/debugLog";
import type {
  Session,
  SessionConfig,
  SessionState,
  SessionMetadata,
  Subagent,
  SkillInvocation,
  CommandHistoryEntry,
} from "../types/session";
import { useSettingsStore } from "./settings";

interface SessionsState {
  sessions: Session[];
  activeTabId: string | null;
  claudePath: string | null;
  initialized: boolean;
  subagents: Map<string, Subagent[]>; // sessionId -> subagents
  skillInvocations: Map<string, SkillInvocation[]>; // sessionId -> skills (newest first)
  commandHistory: Map<string, CommandHistoryEntry[]>; // sessionId -> commands (newest first)
  killRequest: string | null; // sessionId to kill
  hookChangeCounter: number;
  inspectorOffSessions: Set<string>;
  trafficRecording: Map<string, string>; // sessionId -> file path
  processHealth: Map<string, { rss: number; heapUsed: number; uptime: number }>;
  seenToolNames: Set<string>; // [TA-02] all unique tool names observed across sessions
  seenEventKinds: Set<string>; // all unique tap event kinds observed across sessions

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
  requestKill: (id: string) => void;
  clearKillRequest: () => void;
  bumpHookChange: () => void;
  setInspectorOff: (id: string, off: boolean) => void;
  startTrafficLog: (id: string, path: string) => void;
  stopTrafficLog: (id: string) => void;
  addSubagent: (sessionId: string, subagent: Subagent) => void;
  updateSubagent: (sessionId: string, subagentId: string, updates: Partial<Subagent>) => void;
  removeSubagent: (sessionId: string, subagentId: string) => void;
  addSkillInvocation: (sessionId: string, invocation: SkillInvocation) => void;
  removeSkillInvocation: (sessionId: string, invocationId: string) => void;
  addCommandHistory: (sessionId: string, command: string, ts: number) => void;
  updateProcessHealth: (id: string, data: { rss: number; heapUsed: number; uptime: number }) => void;
  addSeenToolName: (name: string) => void;
  addSeenEventKind: (kind: string) => void;
}

export const useSessionStore = create<SessionsState>((set) => ({
  sessions: [],
  activeTabId: null,
  claudePath: null,
  initialized: false,
  subagents: new Map(),
  skillInvocations: new Map(),
  commandHistory: new Map(),
  killRequest: null,
  hookChangeCounter: 0,
  inspectorOffSessions: new Set(),
  trafficRecording: new Map(),
  processHealth: new Map(),
  seenToolNames: new Set(),
  seenEventKinds: new Set(),

  init: async () => {
    trace("init: start");
    let sessions: Session[] = [];
    try {
      sessions = await traceAsync("init: load_persisted_sessions", () =>
        invoke<Session[]>("load_persisted_sessions")
      , {
        module: "session",
        event: "session.init.load_persisted_sessions",
        warnAboveMs: 500,
        data: {},
      });
      // Filter out empty dead sessions (no conversation to resume)
      sessions = sessions.filter(
        (s) => s.state !== "dead"
          || !!s.config.resumeSession
          || !!s.metadata.nodeSummary
          || s.metadata.assistantMessageCount > 0
      ).map((s) => ({
        ...s,
        config: {
          ...s.config,
          launchWorkingDir: s.config.launchWorkingDir || s.config.workingDir,
        },
      }));
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
    // [PS-05] [DS-08] Kill orphans + detect CLI + TUI mode in parallel; all must complete before claudePath is set
    const [claudePath] = await Promise.all([
      traceAsync("init: detect_claude_cli", () => invoke<string>("detect_claude_cli"))
        .catch((e) => { dlog("session", null, `CLI detection failed: ${e}`, "ERR"); return null as string | null; }),
      sessionIds.size > 0
        ? traceAsync("init: kill_orphan_sessions", () =>
            invoke<number>("kill_orphan_sessions", { sessionIds: [...sessionIds] })
          , {
            module: "session",
            event: "session.init.kill_orphan_sessions",
            warnAboveMs: 500,
            data: { sessionIdCount: sessionIds.size },
          }).then((n) => { if (n > 0) trace(`init: killed ${n} orphan(s)`, { module: "session", event: "session.init.orphans_killed", data: { count: n } }); })
           .catch((e) => dlog("session", null, `orphan cleanup failed: ${e}`, "ERR"))
        : Promise.resolve(),
      // [PS-06] Proxy lifecycle: start API proxy, store port, listen for route events
      traceAsync("init: start_api_proxy", () => {
        const { providerConfig } = useSettingsStore.getState();
        return invoke<number>("start_api_proxy", { config: providerConfig })
          .then((port) => {
            useSettingsStore.getState().setProxyPort(port);
            trace(`init: proxy started on port ${port}`, {
              module: "proxy",
              event: "proxy.started",
              data: { port },
            });
            // Sync system prompt rules to proxy
            const rules = useSettingsStore.getState().systemPromptRules;
            if (rules.length > 0) {
              invoke("update_system_prompt_rules", { rules }).catch(() => {});
            }
            // Sync compression toggle to proxy
            const { compressionEnabled } = useSettingsStore.getState();
            invoke("set_compression_enabled", { enabled: compressionEnabled }).catch(() => {});
            // Listen for routing events from the proxy for debug visibility
            listen<{ model: string; provider: string; rewrite: string | null; path: string }>(
              "proxy-route",
              (ev) => {
                const { model, provider, rewrite, path } = ev.payload;
                const rw = rewrite ? ` → ${rewrite}` : "";
                dlog("proxy", null, `${path} ${model}${rw} → ${provider}`);
              },
            );
          })
          .catch((e) => dlog("session", null, `proxy start failed: ${e}`, "ERR"));
      }, {
        module: "proxy",
        event: "session.init.start_api_proxy",
        warnAboveMs: 500,
        data: {},
      }),
    ]);
    if (claudePath) {
      set({ claudePath });
      trace("init: claudePath set", {
        module: "session",
        event: "session.init.claude_path_set",
        data: { claudePath },
      });
    }

    // Refresh Anthropic model catalog from docs (fire-and-forget, updates settings store)
    fetchAnthropicModelCatalog().then(({ models }) => {
      const { providerConfig, setProviderConfig } = useSettingsStore.getState();
      const updated = providerConfig.providers.map((p) =>
        p.kind === "anthropic_compatible" ? { ...p, knownModels: models } : p
      );
      if (JSON.stringify(updated) !== JSON.stringify(providerConfig.providers)) {
        setProviderConfig({ ...providerConfig, providers: updated });
        dlog("session", null, `model catalog refreshed: ${models.length} models`, "LOG");
      }
    }).catch(() => {});
  },

  createSession: async (name, config, opts = {}) => {
    const session = await traceAsync("session.create", () => invoke<Session>("create_session", { name, config }), {
      module: "session",
      event: "session.create",
      warnAboveMs: 250,
      data: {
        name,
        workingDir: config.workingDir,
        resumeSession: config.resumeSession,
      },
    });
    const tagged = {
      ...session,
      config: {
        ...session.config,
        launchWorkingDir: session.config.launchWorkingDir || config.launchWorkingDir || config.workingDir,
      },
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
        // Prefer the nearest live tab; if none remain, leave the terminal area unselected.
        activeTabId = findNearestLiveTab(sessions, closedIndex);
      }
      const subagents = new Map(s.subagents);
      subagents.delete(id);
      const skillInvocations = new Map(s.skillInvocations);
      skillInvocations.delete(id);
      const commandHistory = new Map(s.commandHistory);
      commandHistory.delete(id);
      const inspectorOffSessions = new Set(s.inspectorOffSessions);
      inspectorOffSessions.delete(id);
      const trafficRecording = new Map(s.trafficRecording);
      if (trafficRecording.has(id)) {
        trafficRecording.delete(id);
        invoke("stop_traffic_log", { sessionId: id }).catch(() => {});
      }
      const processHealth = new Map(s.processHealth);
      processHealth.delete(id);
      return { sessions, activeTabId, subagents, skillInvocations, commandHistory, inspectorOffSessions, trafficRecording, processHealth };
    });
    useActivityStore.getState().clearSession(id);
    removeDebugLogSession(id);
    // Persist immediately so the removal is captured even if the app closes
    useSessionStore.getState().persist();
    // Notify backend (best-effort, fire-and-forget)
    invoke("close_session", { id }).catch((err) =>
      dlog("session", id, `close_session IPC failed: ${err}`, "WARN")
    );
    invoke("unbind_session_provider", { sessionId: id }).catch(() => {});
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

  // [PS-01] Frontend-owned persistence via persist_sessions_json
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
    await traceAsync("session.persist", () => invoke("persist_sessions_json", {
      json: JSON.stringify(snapshots, null, 2),
    }), {
      module: "session",
      event: "session.persist",
      warnAboveMs: 250,
      data: {
        count: snapshots.length,
      },
    });
  },

  renameSession: (id, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, name } : x
      ),
    }));
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

  addSeenToolName: (name) => {
    set((s) => {
      if (s.seenToolNames.has(name)) return s;
      const next = new Set(s.seenToolNames);
      next.add(name);
      return { seenToolNames: next };
    });
  },

  addSeenEventKind: (kind) => {
    set((s) => {
      if (s.seenEventKinds.has(kind)) return s;
      const next = new Set(s.seenEventKinds);
      next.add(kind);
      return { seenEventKinds: next };
    });
  },

  startTrafficLog: (id, path) => {
    set((s) => {
      const next = new Map(s.trafficRecording);
      next.set(id, path);
      return { trafficRecording: next };
    });
  },

  stopTrafficLog: (id) => {
    set((s) => {
      const next = new Map(s.trafficRecording);
      next.delete(id);
      return { trafficRecording: next };
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

  removeSubagent: (sessionId, subagentId) => {
    let removed = false;
    set((s) => {
      const map = new Map(s.subagents);
      const list = map.get(sessionId);
      if (!list) return s;
      const filtered = list.filter((sa) => sa.id !== subagentId);
      if (filtered.length === list.length) return s;
      map.set(sessionId, filtered);
      removed = true;
      return { subagents: map };
    });
    if (removed) {
      useActivityStore.getState().clearAgentSearchActivity(sessionId, subagentId);
    }
  },

  addSkillInvocation: (sessionId, invocation) => {
    set((s) => {
      const map = new Map(s.skillInvocations);
      const existing = map.get(sessionId) || [];
      // Dedup by id
      if (existing.some((si) => si.id === invocation.id)) return s;
      const updated = [invocation, ...existing];
      map.set(sessionId, updated.length > 50 ? updated.slice(0, 50) : updated);
      return { skillInvocations: map };
    });
  },

  removeSkillInvocation: (sessionId, invocationId) => {
    set((s) => {
      const map = new Map(s.skillInvocations);
      const list = map.get(sessionId);
      if (!list) return s;
      const updated = list.filter((si) => si.id !== invocationId);
      if (updated.length === list.length) return s;
      map.set(sessionId, updated);
      return { skillInvocations: map };
    });
  },

  addCommandHistory: (sessionId, command, ts) => {
    const normalized = command.toLowerCase();
    set((s) => {
      const map = new Map(s.commandHistory);
      const existing = map.get(sessionId) || [];
      // Consecutive dedup: skip if most recent entry is identical
      // (suppresses duplicates from PTY + tap dual detection)
      if (existing[0]?.cmd === normalized) return s;
      const updated = [{ cmd: normalized, ts }, ...existing];
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
