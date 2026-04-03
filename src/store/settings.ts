import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { LaunchPreset, SessionConfig, PastSession, ProviderConfig, ModelRoute, SystemPromptRule } from "../types/session";
import { DEFAULT_SESSION_CONFIG, DEFAULT_PROVIDER_CONFIG } from "../types/session";
import { normalizePath, parseWorktreePath } from "../lib/paths";
import type { BinarySettingField, JsonSchema } from "../lib/settingsSchema";
import type { EnvVarEntry } from "../lib/envVars";
import type { ModelRegistryEntry } from "../lib/claude";
import { useSessionStore } from "./sessions";

export interface RecordingConfig {
  taps: {
    enabled: boolean;
    categories: Record<string, boolean>;
  };
  traffic: { enabled: boolean };
  globalHooks: { enabled: boolean };
  maxAgeHours: number;
}

export const DEFAULT_RECORDING_CONFIG: RecordingConfig = {
  taps: {
    enabled: true,
    categories: {
      parse: true, stringify: true,
      console: true, fs: true, spawn: true, fetch: true,
      exit: true, timer: true, stdout: true, stderr: true,
      require: true, bun: true,
      websocket: false, net: false, stream: false,
    },
  },
  traffic: { enabled: true },
  globalHooks: { enabled: true },
  maxAgeHours: 72,
};

function syncRulesToProxy() {
  const rules = useSettingsStore.getState().systemPromptRules;
  invoke("update_system_prompt_rules", { rules }).catch(() => {});
}

export interface CliOption {
  flag: string;        // e.g. "--model"
  argName?: string;    // e.g. "<model>"
  description: string; // e.g. "Model for the current session..."
}

export interface CliCommand {
  name: string;        // e.g. "auth"
  description: string; // e.g. "Manage authentication"
}

export interface CliCapabilities {
  models: string[];
  permissionModes: string[];
  flags: string[];
  options: CliOption[];
  commands: CliCommand[];
}

export interface SlashCommand {
  cmd: string;
  desc: string;
}

export interface ObservedPrompt {
  id: string;
  text: string;
  model: string;
  firstSeenAt: number;
  label: string;
}

interface SettingsState {
  recentDirs: string[];
  presets: LaunchPreset[];
  lastConfig: SessionConfig;
  savedDefaults: SessionConfig | null;
  showLauncher: boolean;
  launcherGeneration: number;
  themeName: string;
  notificationsEnabled: boolean;
  cliVersion: string | null;
  previousCliVersion: string | null;
  cliCapabilities: CliCapabilities;
  binarySettingsSchema: BinarySettingField[]; // [CM-10] Cached in localStorage to avoid re-scanning on startup
  settingsJsonSchema: JsonSchema | null;
  knownEnvVars: EnvVarEntry[];
  slashCommands: SlashCommand[];

  commandUsage: Record<string, number>;
  commandBarExpanded: boolean;
  commandRefreshTrigger: number;
  showConfigManager: string | false;
  sidePanel: "debug" | "diff" | "search" | null;
  replaceSessionId: string | null; // Session to close when launcher launches (Ctrl+Click relaunch)
  pastSessions: PastSession[];
  pastSessionsLoading: boolean;
  sessionNames: Record<string, string>;
  sessionConfigs: Record<string, Partial<SessionConfig>>;
  observedPrompts: ObservedPrompt[];
  savedPrompts: Array<{ id: string; name: string; text: string }>;
  providerConfig: ProviderConfig;
  proxyPort: number | null;
  apiIp: string | null;
  systemPromptRules: SystemPromptRule[];
  modelRegistry: Record<string, ModelRegistryEntry>;
  recordingConfig: RecordingConfig;

  // Actions
  addRecentDir: (dir: string) => void;
  removeRecentDir: (dir: string) => void;
  savePreset: (name: string, config: Partial<SessionConfig>) => void;
  removePreset: (id: string) => void;
  setLastConfig: (config: SessionConfig) => void;
  setSavedDefaults: (config: SessionConfig) => void;
  setShowLauncher: (show: boolean) => void;
  setThemeName: (name: string) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setCliCapabilities: (version: string, capabilities: CliCapabilities) => void;
  recordCommandUsage: (command: string) => void;
  setSlashCommands: (cmds: SlashCommand[]) => void;
  setReplaceSessionId: (id: string | null) => void;
  setShowConfigManager: (show: string | false) => void;
  setCommandBarExpanded: (expanded: boolean) => void;
  setSidePanel: (panel: "debug" | "diff" | "search" | null) => void;
  bootstrapCommandUsage: () => Promise<void>;
  triggerCommandRefresh: () => void;
  setSessionName: (id: string, name: string) => void;
  cacheSessionConfig: (id: string, config: SessionConfig) => void;
  loadPastSessions: () => Promise<void>;
  loadBinarySettingsSchema: () => Promise<void>;
  loadSettingsJsonSchema: () => Promise<void>;
  loadKnownEnvVars: (cliPath?: string | null) => Promise<void>;
  addObservedPrompt: (text: string, model: string) => void;
  addSavedPrompt: (name: string, text: string) => void;
  updateSavedPrompt: (id: string, updates: { name?: string; text?: string }) => void;
  removeSavedPrompt: (id: string) => void;
  setProviderConfig: (config: ProviderConfig) => void;
  setProxyPort: (port: number | null) => void;
  setApiIp: (ip: string) => void;
  addSystemPromptRule: () => void;
  updateSystemPromptRule: (id: string, updates: Partial<Omit<SystemPromptRule, "id">>) => void;
  removeSystemPromptRule: (id: string) => void;
  reorderSystemPromptRules: (id: string, direction: -1 | 1) => void;
  updateModelRegistry: (entry: ModelRegistryEntry) => void;
  setRecordingConfig: (config: Partial<RecordingConfig>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      recentDirs: [],
      presets: [],
      lastConfig: DEFAULT_SESSION_CONFIG,
      savedDefaults: null,
      showLauncher: false,
      launcherGeneration: 0,
      themeName: "Claude",
      notificationsEnabled: true,
      cliVersion: null,
      previousCliVersion: null,
      cliCapabilities: { models: [], permissionModes: [], flags: [], options: [], commands: [] },
      binarySettingsSchema: [],
      settingsJsonSchema: null,
      knownEnvVars: [],
      slashCommands: [],
      commandUsage: {},
      commandBarExpanded: false,
      commandRefreshTrigger: 0,
      showConfigManager: false,
      sidePanel: null,
      replaceSessionId: null,
      pastSessions: [],
      pastSessionsLoading: false,
      sessionNames: {},
      sessionConfigs: {},
      observedPrompts: [],
      savedPrompts: [],
      providerConfig: DEFAULT_PROVIDER_CONFIG,
      proxyPort: null,
      apiIp: null,
      systemPromptRules: [],
      modelRegistry: {},
      recordingConfig: DEFAULT_RECORDING_CONFIG,

      addRecentDir: (dir) =>
        set((s) => {
          const wt = parseWorktreePath(dir);
          const norm = normalizePath(wt ? wt.projectRoot : dir);
          const normLower = norm.toLowerCase();
          return {
            recentDirs: [norm, ...s.recentDirs.filter((d) =>
              normalizePath(d).toLowerCase() !== normLower
            )].slice(0, 20),
          };
        }),

      removeRecentDir: (dir) =>
        set((s) => {
          const normLower = normalizePath(dir).toLowerCase();
          return {
            recentDirs: s.recentDirs.filter((d) =>
              normalizePath(d).toLowerCase() !== normLower
            ),
          };
        }),

      savePreset: (name, config) =>
        set((s) => ({
          presets: [
            ...s.presets,
            { id: crypto.randomUUID(), name, config },
          ],
        })),

      removePreset: (id) =>
        set((s) => ({
          presets: s.presets.filter((p) => p.id !== id),
        })),

      setLastConfig: (config) => set({
        lastConfig: {
          ...config,
          workingDir: normalizePath(config.workingDir),
        },
      }),

      setSavedDefaults: (config) => set({
        savedDefaults: {
          ...config,
          workingDir: normalizePath(config.workingDir),
          resumeSession: null,
          continueSession: false,
          sessionId: null,
          runMode: false,
        },
      }),

      setShowLauncher: (show) => set((s) => ({
        showLauncher: show,
        ...(show ? { launcherGeneration: s.launcherGeneration + 1 } : {}),
      })),

      setThemeName: (name) => set({ themeName: name }),

      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),

      setCliCapabilities: (version, capabilities) =>
        set((s) => ({
          previousCliVersion: s.cliVersion,
          cliVersion: version,
          cliCapabilities: capabilities,
        })),

      recordCommandUsage: (command) =>
        set((s) => {
          const normalized = command.toLowerCase();
          return {
            commandUsage: {
              ...s.commandUsage,
              [normalized]: (s.commandUsage[normalized] || 0) + 1,
            },
          };
        }),

      setSlashCommands: (cmds) => set({ slashCommands: cmds }),
      setCommandBarExpanded: (expanded) => set({ commandBarExpanded: expanded }),
      setShowConfigManager: (show) => set({ showConfigManager: show }),
      setSidePanel: (panel) => set({ sidePanel: panel }),
      bootstrapCommandUsage: async () => {
        try {
          const scanned = await invoke<Record<string, number>>("scan_command_usage");
          set((s) => {
            const merged = { ...s.commandUsage };
            for (const [cmd, count] of Object.entries(scanned)) {
              merged[cmd] = Math.max(merged[cmd] || 0, count);
            }
            return { commandUsage: merged };
          });
        } catch {
          // scan failed — no problem, in-app counts still work
        }
      },
      triggerCommandRefresh: () =>
        set((s) => ({ commandRefreshTrigger: s.commandRefreshTrigger + 1 })),
      setReplaceSessionId: (id) => set({ replaceSessionId: id }),
      setSessionName: (id, name) =>
        set((s) => ({
          sessionNames: { ...s.sessionNames, [id]: name },
        })),
      cacheSessionConfig: (id, config) =>
        set((s) => {
          const partial: Partial<SessionConfig> = {
            model: config.model,
            permissionMode: config.permissionMode,
            dangerouslySkipPermissions: config.dangerouslySkipPermissions,
            effort: config.effort,
            agent: config.agent,
            maxBudget: config.maxBudget,
            verbose: config.verbose,
            debug: config.debug,
            projectDir: config.projectDir,
            extraFlags: config.extraFlags,
            systemPrompt: config.systemPrompt,
            appendSystemPrompt: config.appendSystemPrompt,
            allowedTools: config.allowedTools.length > 0 ? config.allowedTools : undefined,
            disallowedTools: config.disallowedTools.length > 0 ? config.disallowedTools : undefined,
            additionalDirs: config.additionalDirs.length > 0 ? config.additionalDirs : undefined,
            mcpConfig: config.mcpConfig,
          };
          // Strip undefined/null/default values to keep entries small
          for (const [k, v] of Object.entries(partial)) {
            if (v === undefined || v === null || v === false || v === "" || v === "default") {
              delete (partial as Record<string, unknown>)[k];
            }
          }
          if (Object.keys(partial).length === 0) return s;
          return { sessionConfigs: { ...s.sessionConfigs, [id]: partial } };
        }),
      loadPastSessions: async () => {
        set({ pastSessionsLoading: true });
        try {
          const sessions = await invoke<PastSession[]>("list_past_sessions");
          // Prune sessionNames and sessionConfigs to only IDs present in loaded sessions
          const idSet = new Set(sessions.map((s) => s.id));
          set((prev) => {
            const names: Record<string, string> = {};
            for (const [k, v] of Object.entries(prev.sessionNames)) {
              if (idSet.has(k)) names[k] = v;
            }
            const configs: Record<string, Partial<SessionConfig>> = {};
            for (const [k, v] of Object.entries(prev.sessionConfigs)) {
              if (idSet.has(k)) configs[k] = v;
            }
            return { pastSessions: sessions, pastSessionsLoading: false, sessionNames: names, sessionConfigs: configs };
          });
        } catch {
          set({ pastSessionsLoading: false });
        }
      },
      loadBinarySettingsSchema: async () => {
        try {
          const claudePath = useSessionStore.getState().claudePath;
          const fields = await invoke<BinarySettingField[]>("discover_settings_schema", { cliPath: claudePath });
          set({ binarySettingsSchema: fields });
        } catch {
          // Binary scan failed — no problem, CLI help + static fields still work
        }
      },
      loadSettingsJsonSchema: async () => {
        try {
          const raw = await invoke<string>("fetch_settings_schema");
          const schema = JSON.parse(raw) as JsonSchema;
          set({ settingsJsonSchema: schema });
        } catch {
          // Network fetch failed — Zustand persistence provides offline fallback
        }
      },
      loadKnownEnvVars: async (cliPath) => {
        try {
          const path = cliPath ?? useSessionStore.getState().claudePath;
          const vars = await invoke<EnvVarEntry[]>("discover_env_vars", { cliPath: path ?? null });
          set({ knownEnvVars: vars });
        } catch {
          // Binary scan failed — no problem, UI just shows empty env vars panel
        }
      },

      addObservedPrompt: (text, model) => set((s) => {
        if (s.observedPrompts.some((p) => p.text === text)) return s;
        const label = text.slice(0, 60).replace(/\n/g, " ").trim() + (text.length > 60 ? "..." : "");
        const entry: ObservedPrompt = {
          id: crypto.randomUUID(), text, model, firstSeenAt: Date.now(), label,
        };
        return { observedPrompts: [...s.observedPrompts, entry].slice(-50) };
      }),

      addSavedPrompt: (name, text) => set((s) => ({
        savedPrompts: [...s.savedPrompts, { id: crypto.randomUUID(), name, text }],
      })),

      updateSavedPrompt: (id, updates) => set((s) => ({
        savedPrompts: s.savedPrompts.map((p) =>
          p.id === id ? { ...p, ...updates } : p
        ),
      })),

      removeSavedPrompt: (id) => set((s) => ({
        savedPrompts: s.savedPrompts.filter((p) => p.id !== id),
      })),

      setProviderConfig: (config) => set({ providerConfig: config }),
      setProxyPort: (port) => set({ proxyPort: port }),
      setApiIp: (ip) => set({ apiIp: ip }),

      addSystemPromptRule: () => set((s) => ({
        systemPromptRules: [...s.systemPromptRules, {
          id: crypto.randomUUID(),
          name: "New Rule",
          pattern: "",
          replacement: "",
          flags: "g",
          enabled: true,
        }],
      })),

      updateSystemPromptRule: (id, updates) => {
        set((s) => ({
          systemPromptRules: s.systemPromptRules.map((r) =>
            r.id === id ? { ...r, ...updates } : r
          ),
        }));
        syncRulesToProxy();
      },

      removeSystemPromptRule: (id) => {
        set((s) => ({
          systemPromptRules: s.systemPromptRules.filter((r) => r.id !== id),
        }));
        syncRulesToProxy();
      },

      reorderSystemPromptRules: (id, direction) => {
        set((s) => {
          const idx = s.systemPromptRules.findIndex((r) => r.id === id);
          if (idx < 0) return s;
          const target = idx + direction;
          if (target < 0 || target >= s.systemPromptRules.length) return s;
          const arr = [...s.systemPromptRules];
          [arr[idx], arr[target]] = [arr[target], arr[idx]];
          return { systemPromptRules: arr };
        });
        syncRulesToProxy();
      },
      updateModelRegistry: (entry) => set((s) => {
        const MAX_ENTRIES = 50;
        const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const updated = { ...s.modelRegistry, [entry.modelId]: { ...entry, lastSeenAt: now } };
        // Prune entries older than 90 days, cap at 50
        const entries = Object.values(updated)
          .filter(e => now - e.lastSeenAt < NINETY_DAYS)
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
          .slice(0, MAX_ENTRIES);
        const pruned: Record<string, ModelRegistryEntry> = {};
        for (const e of entries) pruned[e.modelId] = e;
        return { modelRegistry: pruned };
      }),

      setRecordingConfig: (config) => set((s) => ({
        recordingConfig: { ...s.recordingConfig, ...config },
      })),
    }),
    {
      name: "claude-tabs-settings",
      version: 3,
      storage: createJSONStorage(() => localStorage),
      // [CI-04] Migration: v0 drops tierOverrides + converts modelPatterns to routes; v1->v2 adds modelRegistry
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;
        if (version === 0) {
          // Drop tier overrides (replaced by model routes in proxy)
          delete state.tierOverrides;
          // Convert old modelPatterns on providers into routes
          const pc = state.providerConfig as Record<string, unknown> | undefined;
          if (pc?.providers && Array.isArray(pc.providers)) {
            const routes: ModelRoute[] = [];
            for (const p of pc.providers as Array<Record<string, unknown>>) {
              if (Array.isArray(p.modelPatterns)) {
                for (const pat of p.modelPatterns as string[]) {
                  routes.push({ id: `m-${p.id}-${routes.length}`, pattern: pat, providerId: p.id as string });
                }
                delete p.modelPatterns;
              }
            }
            if (routes.length === 0) {
              routes.push({ id: "default-catchall", pattern: "*", providerId: "anthropic" });
            }
            pc.routes = routes;
          }
        }
        if (version < 2) {
          // Add model registry
          if (!state.modelRegistry) state.modelRegistry = {};
        }
        if (version < 3) {
          // Add recording config
          if (!state.recordingConfig) state.recordingConfig = DEFAULT_RECORDING_CONFIG;
        }
        return state;
      },
      // Don't persist transient UI state
      partialize: (state) => ({
        recentDirs: state.recentDirs,
        presets: state.presets,
        lastConfig: state.lastConfig,
        savedDefaults: state.savedDefaults,
        themeName: state.themeName,
        notificationsEnabled: state.notificationsEnabled,
        cliVersion: state.cliVersion,
        previousCliVersion: state.previousCliVersion,
        cliCapabilities: state.cliCapabilities,
        binarySettingsSchema: state.binarySettingsSchema,
        settingsJsonSchema: state.settingsJsonSchema,
        commandUsage: state.commandUsage,
        commandBarExpanded: state.commandBarExpanded,
        sessionNames: state.sessionNames,
        sessionConfigs: state.sessionConfigs,
        savedPrompts: state.savedPrompts,
        providerConfig: state.providerConfig,
        systemPromptRules: state.systemPromptRules,
        modelRegistry: state.modelRegistry,
        recordingConfig: state.recordingConfig,
      }),
    }
  )
);
