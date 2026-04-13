import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { LaunchPreset, SessionConfig, PastSession, ProviderConfig, SystemPromptRule } from "../types/session";
import {
  DEFAULT_SESSION_CONFIG,
  DEFAULT_PROVIDER_CONFIG,
  CODEX_PROVIDER,
  OPENAI_CODEX_PRIMARY_MODEL,
  OPENAI_CODEX_SMALL_MODEL,
  buildOpenAICodexMappings,
  buildOpenAICodexModels,
} from "../types/session";
import { normalizePath, parseWorktreePath } from "../lib/paths";
import type { BinarySettingField, JsonSchema } from "../lib/settingsSchema";
import type { EnvVarEntry } from "../lib/envVars";
import type { ModelRegistryEntry } from "../lib/claude";
import { dlog, setDebugCaptureEnabled } from "../lib/debugLog";
import { traceAsync } from "../lib/perfTrace";
import { useSessionStore } from "./sessions";

export interface RecordingConfig {
  taps: {
    enabled: boolean;
    categories: Record<string, boolean>;
  };
  traffic: { enabled: boolean };
  debugCapture: boolean;
  maxAgeHours: number;
  noisyEventKinds: string[];
}

export const DEFAULT_NOISY_EVENT_KINDS: string[] = [
  "ApiTelemetry", "ProcessHealth", "EnvAccess", "TextDecoderChunk",
];

// [CI-05] Recording defaults expand TAP categories, keep stdout/stderr off, and v6 backfills older persisted configs.
// [CI-06] debugCapture field controls DEBUG-level capture; v8 migration backfills true for older states.
export const DEFAULT_RECORDING_CONFIG: RecordingConfig = {
  taps: {
    enabled: true,
    categories: {
      parse: true, stringify: true,
      console: true, fs: true, spawn: true, fetch: true,
      exit: true, timer: true, stdout: false, stderr: false,
      require: true, bun: true,
      websocket: false, net: false, stream: false,
      fspromises: true, bunfile: true, abort: true,
      fswatch: false, textdecoder: false, events: false, envproxy: false,
    },
  },
  traffic: { enabled: true },
  debugCapture: true,
  maxAgeHours: 72,
  noisyEventKinds: DEFAULT_NOISY_EVENT_KINDS,
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
  workspaceDefaults: Record<string, Partial<SessionConfig>>;
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
  rightPanelTab: "debug" | "activity" | "search";
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
  compressionEnabled: boolean;
  activityViewMode: "response" | "session";

  // Actions
  addRecentDir: (dir: string) => void;
  removeRecentDir: (dir: string) => void;
  pruneRecentDirs: () => Promise<void>;
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
  setRightPanelTab: (panel: "debug" | "activity" | "search") => void;
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
  setCompressionEnabled: (enabled: boolean) => void;
  setActivityViewMode: (mode: "response" | "session") => void;
  toggleNoisyEventKind: (kind: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      recentDirs: [],
      presets: [],
      lastConfig: DEFAULT_SESSION_CONFIG,
      savedDefaults: null,
      workspaceDefaults: {},
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
      rightPanelTab: "activity",
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
      compressionEnabled: false,
      activityViewMode: "response",

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

      // [SL-20] Prune recent dirs that no longer exist on disk
      pruneRecentDirs: async () => {
        const dirs = get().recentDirs;
        if (dirs.length === 0) return;
        const results = await Promise.all(
          dirs.map((d) => invoke<boolean>("dir_exists", { path: normalizePath(d) }))
        );
        const valid = dirs.filter((_, i) => results[i]);
        if (valid.length < dirs.length) set({ recentDirs: valid });
      },

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

      // [SL-21] Workspace defaults: setSavedDefaults writes per-workspace entry keyed by lowercased project root
      setSavedDefaults: (config) => set((s) => {
        const stripped = {
          ...config,
          workingDir: normalizePath(config.workingDir),
          resumeSession: null,
          continueSession: false,
          sessionId: null,
          runMode: false,
          forkSession: false,
        };

        // Per-workspace defaults keyed by normalized project root (same pattern as addRecentDir)
        const wt = parseWorktreePath(config.workingDir);
        const wsKey = normalizePath(wt ? wt.projectRoot : config.workingDir).toLowerCase();

        const wsDefaults: Partial<SessionConfig> = {
          model: stripped.model,
          permissionMode: stripped.permissionMode,
          dangerouslySkipPermissions: stripped.dangerouslySkipPermissions,
          effort: stripped.effort,
          agent: stripped.agent,
          maxBudget: stripped.maxBudget,
          verbose: stripped.verbose,
          debug: stripped.debug,
          projectDir: stripped.projectDir,
          extraFlags: stripped.extraFlags,
          systemPrompt: stripped.systemPrompt,
          appendSystemPrompt: stripped.appendSystemPrompt,
          allowedTools: stripped.allowedTools,
          disallowedTools: stripped.disallowedTools,
          additionalDirs: stripped.additionalDirs,
          mcpConfig: stripped.mcpConfig,
          providerId: stripped.providerId,
        };

        return {
          savedDefaults: stripped,
          workspaceDefaults: wsKey
            ? { ...s.workspaceDefaults, [wsKey]: wsDefaults }
            : s.workspaceDefaults,
        };
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
      setRightPanelTab: (panel) => set({ rightPanelTab: panel }),
      bootstrapCommandUsage: async () => {
        try {
          dlog("discovery", null, "command-usage bootstrap started", "DEBUG", {
            event: "discovery.command_usage_started",
            data: {},
          });
          const scanned = await traceAsync("discovery.scan_command_usage", () => invoke<Record<string, number>>("scan_command_usage"), {
            module: "discovery",
            event: "discovery.command_usage_perf",
            warnAboveMs: 500,
            data: {},
          });
          set((s) => {
            const merged = { ...s.commandUsage };
            for (const [cmd, count] of Object.entries(scanned)) {
              merged[cmd] = Math.max(merged[cmd] || 0, count);
            }
            return { commandUsage: merged };
          });
          dlog("discovery", null, "command-usage bootstrap completed", "LOG", {
            event: "discovery.command_usage_loaded",
            data: {
              uniqueCommands: Object.keys(scanned).length,
              commands: scanned,
            },
          });
        } catch (err) {
          // scan failed — no problem, in-app counts still work
          dlog("discovery", null, `command-usage bootstrap failed: ${err}`, "WARN", {
            event: "discovery.command_usage_failed",
            data: { error: String(err) },
          });
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
            providerId: config.providerId,
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
          dlog("discovery", null, "past-session discovery started", "LOG", {
            event: "discovery.past_sessions_started",
            data: {},
          });
          const sessions = await traceAsync("discovery.list_past_sessions", () => invoke<PastSession[]>("list_past_sessions"), {
            module: "discovery",
            event: "discovery.past_sessions_perf",
            warnAboveMs: 1000,
            data: {},
          });
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
          dlog("discovery", null, "past-session discovery completed", "LOG", {
            event: "discovery.past_sessions_loaded",
            data: {
              count: sessions.length,
              sessionIds: sessions.map((session) => session.id),
            },
          });
        } catch (err) {
          set({ pastSessionsLoading: false });
          dlog("discovery", null, `past-session discovery failed: ${err}`, "WARN", {
            event: "discovery.past_sessions_failed",
            data: { error: String(err) },
          });
        }
      },
      loadBinarySettingsSchema: async () => {
        try {
          const claudePath = useSessionStore.getState().claudePath;
          dlog("discovery", null, "binary settings-schema discovery started", "DEBUG", {
            event: "discovery.settings_schema_started",
            data: { claudePath },
          });
          const fields = await traceAsync("discovery.discover_settings_schema", () => invoke<BinarySettingField[]>("discover_settings_schema", { cliPath: claudePath }), {
            module: "discovery",
            event: "discovery.settings_schema_perf",
            warnAboveMs: 1000,
            data: { claudePath },
          });
          set({ binarySettingsSchema: fields });
          dlog("discovery", null, "binary settings-schema discovery completed", "LOG", {
            event: "discovery.settings_schema_loaded",
            data: {
              count: fields.length,
              keys: fields.map((field) => field.key),
              claudePath,
            },
          });
        } catch (err) {
          // Binary scan failed — no problem, CLI help + static fields still work
          dlog("discovery", null, `binary settings-schema discovery failed: ${err}`, "WARN", {
            event: "discovery.settings_schema_failed",
            data: { error: String(err) },
          });
        }
      },
      loadSettingsJsonSchema: async () => {
        try {
          dlog("discovery", null, "remote settings schema fetch started", "DEBUG", {
            event: "discovery.settings_json_schema_started",
            data: {},
          });
          const raw = await traceAsync("discovery.fetch_settings_schema", () => invoke<string>("fetch_settings_schema"), {
            module: "discovery",
            event: "discovery.settings_json_schema_perf",
            warnAboveMs: 1000,
            data: {},
          });
          const schema = JSON.parse(raw) as JsonSchema;
          set({ settingsJsonSchema: schema });
          const schemaTitle = "title" in (schema as Record<string, unknown>)
            ? ((schema as Record<string, unknown>).title as string | undefined) ?? null
            : null;
          dlog("discovery", null, "remote settings schema fetch completed", "LOG", {
            event: "discovery.settings_json_schema_loaded",
            data: {
              title: schemaTitle,
              hasProperties: !!schema.properties,
              topLevelPropertyCount: schema.properties ? Object.keys(schema.properties).length : 0,
            },
          });
        } catch (err) {
          // Network fetch failed — Zustand persistence provides offline fallback
          dlog("discovery", null, `remote settings schema fetch failed: ${err}`, "WARN", {
            event: "discovery.settings_json_schema_failed",
            data: { error: String(err) },
          });
        }
      },
      loadKnownEnvVars: async (cliPath) => {
        try {
          const path = cliPath ?? useSessionStore.getState().claudePath;
          dlog("discovery", null, "environment-variable discovery started", "DEBUG", {
            event: "discovery.env_vars_started",
            data: { cliPath: path ?? null },
          });
          const vars = await traceAsync("discovery.discover_env_vars", () => invoke<EnvVarEntry[]>("discover_env_vars", { cliPath: path ?? null }), {
            module: "discovery",
            event: "discovery.env_vars_perf",
            warnAboveMs: 1000,
            data: { cliPath: path ?? null },
          });
          set({ knownEnvVars: vars });
          dlog("discovery", null, "environment-variable discovery completed", "LOG", {
            event: "discovery.env_vars_loaded",
            data: {
              count: vars.length,
              names: vars.map((variable) => variable.name),
              cliPath: path ?? null,
            },
          });
        } catch (err) {
          // Binary scan failed — no problem, UI just shows empty env vars panel
          dlog("discovery", null, `environment-variable discovery failed: ${err}`, "WARN", {
            event: "discovery.env_vars_failed",
            data: { error: String(err) },
          });
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

      setCompressionEnabled: (enabled) => {
        set({ compressionEnabled: enabled });
        invoke("set_compression_enabled", { enabled }).catch(() => {});
      },

      setActivityViewMode: (mode) => set({ activityViewMode: mode }),

      toggleNoisyEventKind: (kind) => set((s) => {
        const current = s.recordingConfig.noisyEventKinds;
        const next = current.includes(kind)
          ? current.filter((k) => k !== kind)
          : [...current, kind].sort();
        return { recordingConfig: { ...s.recordingConfig, noisyEventKinds: next } };
      }),
    }),
    {
      name: "claude-tabs-settings",
      version: 14,
      storage: createJSONStorage(() => localStorage),
      // [CI-04] Persisted settings migrations normalize providerConfig from v0 and extend later stored fields.
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;
        if (version === 0) {
          // Drop tier overrides (replaced by model routes in proxy)
          delete state.tierOverrides;
          // Convert old modelPatterns on providers into routes
          const pc = state.providerConfig as Record<string, unknown> | undefined;
          if (pc?.providers && Array.isArray(pc.providers)) {
            const routes: Array<{ id: string; pattern: string; providerId: string }> = [];
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
        if (version < 4) {
          const recordingConfig = state.recordingConfig as Record<string, unknown> | undefined;
          if (recordingConfig && "globalHooks" in recordingConfig) {
            delete recordingConfig.globalHooks;
          }
        }
        if (version < 5) {
          const recordingConfig = state.recordingConfig as Record<string, unknown> | undefined;
          if (recordingConfig && !Array.isArray(recordingConfig.noisyEventKinds)) {
            recordingConfig.noisyEventKinds = DEFAULT_NOISY_EVENT_KINDS;
          }
        }
        if (version < 6) {
          const rc = state.recordingConfig as { taps?: { categories?: Record<string, boolean> } } | undefined;
          if (rc?.taps?.categories) {
            // Default stdout/stderr off — pure ANSI noise
            rc.taps.categories.stdout = false;
            rc.taps.categories.stderr = false;
            // Add missing categories from MISSED-HOOKS expansion
            if (rc.taps.categories.fspromises === undefined) rc.taps.categories.fspromises = true;
            if (rc.taps.categories.bunfile === undefined) rc.taps.categories.bunfile = true;
            if (rc.taps.categories.abort === undefined) rc.taps.categories.abort = true;
            if (rc.taps.categories.fswatch === undefined) rc.taps.categories.fswatch = false;
            if (rc.taps.categories.textdecoder === undefined) rc.taps.categories.textdecoder = false;
            if (rc.taps.categories.events === undefined) rc.taps.categories.events = false;
            if (rc.taps.categories.envproxy === undefined) rc.taps.categories.envproxy = false;
          }
        }
        if (version < 7) {
          if (!state.workspaceDefaults) state.workspaceDefaults = {};
        }
        if (version < 8) {
          const rc = state.recordingConfig as { debugCapture?: boolean } | undefined;
          if (rc && rc.debugCapture === undefined) rc.debugCapture = true;
        }
        // v8→v9: Convert global routes to per-provider modelMappings, add kind/predefined fields
        if (version < 9) {
          const pc = state.providerConfig as Record<string, unknown> | undefined;
          if (pc?.providers && Array.isArray(pc.providers)) {
            const routes = (pc.routes as Array<{ id: string; pattern: string; rewriteModel?: string; providerId: string }>) ?? [];
            for (const p of pc.providers as Array<Record<string, unknown>>) {
              // Collect routes targeting this provider and convert to modelMappings
              const mappings = routes
                .filter((r) => r.providerId === p.id)
                .map((r) => ({ id: r.id, pattern: r.pattern, rewriteModel: r.rewriteModel }));
              p.modelMappings = mappings;
              if (p.kind === undefined) p.kind = "anthropic_compatible";
              if (p.predefined === undefined) p.predefined = false;
            }
            delete pc.routes;
          }
          // Add providerId to persisted session configs
          if (state.lastConfig && typeof state.lastConfig === "object") {
            (state.lastConfig as Record<string, unknown>).providerId ??= null;
          }
          if (state.savedDefaults && typeof state.savedDefaults === "object") {
            (state.savedDefaults as Record<string, unknown>).providerId ??= null;
          }
        }
        // ── Unconditional config sanitization (runs every load) ──────
        {
          const pc = state.providerConfig as { providers?: Array<Record<string, unknown>> } | undefined;
          if (pc?.providers) {
            // Inject predefined Codex provider if missing
            if (!pc.providers.some((p) => p.id === "openai-codex")) {
              pc.providers.push(CODEX_PROVIDER as never);
            }
            for (const p of pc.providers) {
              // Force canonical names on predefined providers
              if (p.id === "openai-codex") {
                // [PR-02] Persisted OpenAI Codex configs are normalized back to
                // canonical kind/models/mappings on load.
                p.name = "OpenAI";
                p.kind = "openai_codex";
                p.predefined = true;
                const primaryModel = typeof p.codexPrimaryModel === "string" && p.codexPrimaryModel
                  ? p.codexPrimaryModel
                  : OPENAI_CODEX_PRIMARY_MODEL;
                const smallModel = typeof p.codexSmallModel === "string" && p.codexSmallModel
                  ? p.codexSmallModel
                  : OPENAI_CODEX_SMALL_MODEL;
                const defaultMappings = buildOpenAICodexMappings(primaryModel, smallModel);
                const defaultMappingById = new Map(defaultMappings.map((mapping) => [mapping.id, mapping]));
                p.codexPrimaryModel = primaryModel;
                p.codexSmallModel = smallModel;
                p.knownModels = buildOpenAICodexModels(primaryModel, smallModel);
                if (!Array.isArray(p.modelMappings) || p.modelMappings.length === 0) {
                  p.modelMappings = defaultMappings;
                } else {
                  const migratedMappings = p.modelMappings.map((mapping) => {
                    const defaultMapping = defaultMappingById.get(mapping.id);
                    let pattern = mapping.pattern;
                    if (mapping.id === "codex-opus" && pattern === "claude-opus-*") pattern = "opus*";
                    if (mapping.id === "codex-sonnet" && pattern === "claude-sonnet-*") pattern = "sonnet*";
                    if (mapping.id === "codex-haiku" && pattern === "claude-haiku-*") pattern = "haiku*";
                    return {
                      ...mapping,
                      pattern,
                      contextWindow: mapping.contextWindow ?? defaultMapping?.contextWindow,
                    };
                  });
                  const existingIds = new Set(migratedMappings.map((mapping) => mapping.id));
                  for (const defaultMapping of defaultMappings) {
                    if (!existingIds.has(defaultMapping.id)) migratedMappings.push(defaultMapping);
                  }
                  p.modelMappings = migratedMappings;
                }
              }
              if (p.id === "anthropic") {
                p.name = "Anthropic";
              }
              // Backfill missing fields
              if (!Array.isArray(p.knownModels)) p.knownModels = [];
              if (!Array.isArray(p.modelMappings)) p.modelMappings = [];
              // Custom providers: dropdown derives from mapping rewrites, not knownModels
              if (p.id !== "anthropic" && p.kind !== "openai_codex") {
                p.knownModels = [];
              }
            }
          }
        }
        if (version < 14) {
          if (state.compressionEnabled === undefined) state.compressionEnabled = false;
        }
        return state;
      },
      // Don't persist transient UI state
      partialize: (state) => ({
        recentDirs: state.recentDirs,
        presets: state.presets,
        lastConfig: state.lastConfig,
        savedDefaults: state.savedDefaults,
        workspaceDefaults: state.workspaceDefaults,
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
        compressionEnabled: state.compressionEnabled,
        activityViewMode: state.activityViewMode,
      }),
    }
  )
);

// Sync debug capture flag into the zero-import debugLog module
let _prevDebugCapture = useSettingsStore.getState().recordingConfig.debugCapture;
setDebugCaptureEnabled(_prevDebugCapture);
useSettingsStore.subscribe((state) => {
  const next = state.recordingConfig.debugCapture;
  if (next !== _prevDebugCapture) {
    _prevDebugCapture = next;
    setDebugCaptureEnabled(next);
  }
});
