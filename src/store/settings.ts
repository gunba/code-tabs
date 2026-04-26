import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { LaunchPreset, SessionConfig, PastSession, SystemPromptRule, CliKind } from "../types/session";
import { DEFAULT_SESSION_CONFIG } from "../types/session";
import { normalizePath, parseWorktreePath } from "../lib/paths";
import type { BinarySettingField, JsonSchema } from "../lib/settingsSchema";
import type { EnvVarEntry } from "../lib/envVars";
import type { ModelRegistryEntry } from "../lib/claude";
import { dlog, setDebugCaptureEnabled, setDebugCaptureResolver } from "../lib/debugLog";
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

export type RecordingConfigsByCli = Record<CliKind, RecordingConfig>;

export const DEFAULT_NOISY_EVENT_KINDS: string[] = [
  "ApiTelemetry", "ProcessHealth", "EnvAccess", "TextDecoderChunk",
];

// [CI-05] Recording defaults: TAP/traffic disabled, all high-volume tap categories off, parse/stringify and codex-* categories on. v6 backfilled added categories with stdout/stderr forced off; v21 force-quiets persisted configs into recordingConfigsByCli.
// [CI-06] RecordingConfig.debugCapture field controls DEBUG-level capture (default false). v8 backfilled debugCapture=true for older states; v21 force-quiets it back to false alongside the other recording defaults.
export const DEFAULT_RECORDING_CONFIG: RecordingConfig = {
  taps: {
    enabled: false,
    categories: {
      parse: true, stringify: true,
      console: false, fs: false, spawn: false, fetch: false,
      exit: false, timer: false, stdout: false, stderr: false,
      require: false, bun: false,
      websocket: false, net: false, stream: false,
      fspromises: false, bunfile: false, abort: false,
      fswatch: false, textdecoder: false, events: false, envproxy: false,
      "codex-session": true,
      "codex-turn-context": true,
      "codex-token-count": true,
      "codex-tool-call-start": true,
      "codex-tool-input": true,
      "codex-tool-call-complete": true,
      "codex-message": true,
      "codex-thread-name-updated": true,
      "codex-compacted": true,
      "system-prompt": true,
    },
  },
  traffic: { enabled: false },
  debugCapture: false,
  maxAgeHours: 72,
  noisyEventKinds: DEFAULT_NOISY_EVENT_KINDS,
};

const HIGH_VOLUME_TAP_CATEGORIES = [
  "console", "fs", "spawn", "fetch", "exit", "timer", "stdout", "stderr",
  "require", "bun", "websocket", "net", "stream", "fspromises", "bunfile",
  "abort", "fswatch", "textdecoder", "events", "envproxy",
];

function cloneRecordingConfig(config: RecordingConfig = DEFAULT_RECORDING_CONFIG): RecordingConfig {
  return {
    taps: {
      enabled: config.taps.enabled,
      categories: { ...DEFAULT_RECORDING_CONFIG.taps.categories, ...config.taps.categories },
    },
    traffic: { enabled: config.traffic.enabled },
    debugCapture: config.debugCapture,
    maxAgeHours: config.maxAgeHours,
    noisyEventKinds: [...config.noisyEventKinds],
  };
}

function quietRecordingConfig(config: RecordingConfig = DEFAULT_RECORDING_CONFIG): RecordingConfig {
  const cloned = cloneRecordingConfig(config);
  for (const category of HIGH_VOLUME_TAP_CATEGORIES) {
    cloned.taps.categories[category] = false;
  }
  cloned.taps.enabled = false;
  cloned.traffic.enabled = false;
  cloned.debugCapture = false;
  return cloned;
}

function mergeRecordingConfig(base: RecordingConfig, patch: Partial<RecordingConfig>): RecordingConfig {
  return {
    ...base,
    ...patch,
    taps: patch.taps
      ? {
          ...base.taps,
          ...patch.taps,
          categories: {
            ...base.taps.categories,
            ...(patch.taps.categories ?? {}),
          },
        }
      : base.taps,
    traffic: patch.traffic ? { ...base.traffic, ...patch.traffic } : base.traffic,
    noisyEventKinds: patch.noisyEventKinds ? [...patch.noisyEventKinds] : base.noisyEventKinds,
  };
}

export const DEFAULT_RECORDING_CONFIGS_BY_CLI: RecordingConfigsByCli = {
  claude: cloneRecordingConfig(),
  codex: cloneRecordingConfig(),
};

export function getRecordingConfigForCliFromState(
  state: Pick<SettingsState, "recordingConfig" | "recordingConfigsByCli">,
  cli: CliKind,
): RecordingConfig {
  return state.recordingConfigsByCli?.[cli] ?? state.recordingConfig;
}

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

const EMPTY_CLI_CAPABILITIES: CliCapabilities = {
  models: [],
  permissionModes: [],
  flags: [],
  options: [],
  commands: [],
};

export interface SlashCommand {
  cmd: string;
  desc: string;
}

export interface ObservedPrompt {
  id: string;
  cli: CliKind;
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
  /** Per-workspace scratchpad notes, keyed by lowercased normalized project root. */
  workspaceNotes: Record<string, string>;
  showLauncher: boolean;
  launcherGeneration: number;
  themeName: string;
  notificationsEnabled: boolean;
  cliVersions: Record<CliKind, string | null>;
  lastOpenedCliVersions: Record<CliKind, string | null>;
  previousCliVersions: Record<CliKind, string | null>;
  cliVersion: string | null;
  previousCliVersion: string | null;
  cliCapabilitiesByCli: Record<CliKind, CliCapabilities>;
  cliCapabilities: CliCapabilities;
  // [PE-02] Per-CLI schema/env-var caches. Codex schema is mined from the
  // installed native binary; Claude schema is fetched from schemastore +
  // supplemented by binary Zod scan. Legacy mirrors (binarySettingsSchema /
  // settingsJsonSchema / knownEnvVars) keep one-version backwards
  // compatibility for consumers still reading the unkeyed fields.
  binarySettingsFieldsByCli: Record<CliKind, BinarySettingField[]>;
  settingsSchemaByCli: Record<CliKind, JsonSchema | null>;
  knownEnvVarsByCli: Record<CliKind, EnvVarEntry[]>;
  binarySettingsSchema: BinarySettingField[]; // [CM-10] Cached in localStorage to avoid re-scanning on startup
  settingsJsonSchema: JsonSchema | null;
  knownEnvVars: EnvVarEntry[];
  slashCommandsByCli: Record<CliKind, SlashCommand[]>;
  slashCommands: SlashCommand[];

  commandUsage: Record<string, number>;
  commandBarExpanded: boolean;
  commandRefreshTrigger: number;
  showConfigManager: string | false;
  rightPanelTab: "debug" | "response" | "session" | "notes" | "search";
  replaceSessionId: string | null; // Session to close when launcher launches (Ctrl+Click relaunch)
  pastSessions: PastSession[];
  pastSessionsLoading: boolean;
  sessionNames: Record<string, string>;
  sessionConfigs: Record<string, Partial<SessionConfig>>;
  observedPrompts: ObservedPrompt[];
  savedPrompts: Array<{ id: string; name: string; text: string }>;
  proxyPort: number | null;
  apiIp: string | null;
  systemPromptRules: SystemPromptRule[];
  modelRegistry: Record<string, ModelRegistryEntry>;
  recordingConfig: RecordingConfig;
  recordingConfigsByCli: RecordingConfigsByCli;

  // Actions
  addRecentDir: (dir: string) => void;
  removeRecentDir: (dir: string) => void;
  pruneRecentDirs: () => Promise<void>;
  savePreset: (name: string, config: Partial<SessionConfig>) => void;
  removePreset: (id: string) => void;
  setLastConfig: (config: SessionConfig) => void;
  setSavedDefaults: (config: SessionConfig) => void;
  setWorkspaceNotes: (key: string, notes: string) => void;
  setShowLauncher: (show: boolean) => void;
  setThemeName: (name: string) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setLastOpenedCliVersion: (cli: CliKind, version: string | null) => void;
  setCliCapabilitiesForCli: (cli: CliKind, version: string | null, capabilities: CliCapabilities) => void;
  setCliCapabilities: (version: string, capabilities: CliCapabilities) => void;
  recordCommandUsage: (command: string) => void;
  setSlashCommandsForCli: (cli: CliKind, cmds: SlashCommand[]) => void;
  setSlashCommands: (cmds: SlashCommand[]) => void;
  setReplaceSessionId: (id: string | null) => void;
  setShowConfigManager: (show: string | false) => void;
  setCommandBarExpanded: (expanded: boolean) => void;
  setRightPanelTab: (panel: "debug" | "response" | "session" | "notes" | "search") => void;
  bootstrapCommandUsage: () => Promise<void>;
  triggerCommandRefresh: () => void;
  setSessionName: (id: string, name: string) => void;
  cacheSessionConfig: (id: string, config: SessionConfig) => void;
  loadPastSessions: () => Promise<void>;
  loadBinarySettingsSchema: () => Promise<void>;
  loadSettingsJsonSchema: () => Promise<void>;
  loadKnownEnvVars: (cliPath?: string | null) => Promise<void>;
  // [PE-02] Per-CLI loaders. Claude variants mirror into the legacy fields
  // for one version; Codex variants only populate the `.codex` slot.
  loadBinarySettingsFieldsForCli: (cli: CliKind, cliPath?: string | null) => Promise<void>;
  loadSettingsSchemaForCli: (cli: CliKind, cliPath?: string | null) => Promise<void>;
  loadKnownEnvVarsForCli: (cli: CliKind, cliPath?: string | null) => Promise<void>;
  addObservedPrompt: (text: string, model: string, cli?: CliKind) => void;
  addSavedPrompt: (name: string, text: string) => void;
  updateSavedPrompt: (id: string, updates: { name?: string; text?: string }) => void;
  removeSavedPrompt: (id: string) => void;
  setProxyPort: (port: number | null) => void;
  setApiIp: (ip: string) => void;
  addSystemPromptRule: () => void;
  updateSystemPromptRule: (id: string, updates: Partial<Omit<SystemPromptRule, "id">>) => void;
  removeSystemPromptRule: (id: string) => void;
  reorderSystemPromptRules: (id: string, direction: -1 | 1) => void;
  updateModelRegistry: (entry: ModelRegistryEntry) => void;
  setRecordingConfig: (config: Partial<RecordingConfig>) => void;
  setRecordingConfigForCli: (cli: CliKind, config: Partial<RecordingConfig>) => void;
  toggleNoisyEventKind: (kind: string) => void;
  toggleNoisyEventKindForCli: (cli: CliKind, kind: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      recentDirs: [],
      presets: [],
      lastConfig: DEFAULT_SESSION_CONFIG,
      savedDefaults: null,
      workspaceDefaults: {},
      workspaceNotes: {},
      showLauncher: false,
      launcherGeneration: 0,
      themeName: "Claude",
      notificationsEnabled: true,
      cliVersions: { claude: null, codex: null },
      lastOpenedCliVersions: { claude: null, codex: null },
      previousCliVersions: { claude: null, codex: null },
      cliVersion: null,
      previousCliVersion: null,
      cliCapabilitiesByCli: {
        claude: EMPTY_CLI_CAPABILITIES,
        codex: EMPTY_CLI_CAPABILITIES,
      },
      cliCapabilities: EMPTY_CLI_CAPABILITIES,
      binarySettingsFieldsByCli: { claude: [], codex: [] },
      settingsSchemaByCli: { claude: null, codex: null },
      knownEnvVarsByCli: { claude: [], codex: [] },
      binarySettingsSchema: [],
      settingsJsonSchema: null,
      knownEnvVars: [],
      slashCommandsByCli: { claude: [], codex: [] },
      slashCommands: [],
      commandUsage: {},
      commandBarExpanded: false,
      commandRefreshTrigger: 0,
      showConfigManager: false,
      rightPanelTab: "response",
      replaceSessionId: null,
      pastSessions: [],
      pastSessionsLoading: false,
      sessionNames: {},
      sessionConfigs: {},
      observedPrompts: [],
      savedPrompts: [],
      proxyPort: null,
      apiIp: null,
      systemPromptRules: [],
      modelRegistry: {},
      recordingConfig: cloneRecordingConfig(),
      recordingConfigsByCli: {
        claude: cloneRecordingConfig(),
        codex: cloneRecordingConfig(),
      },

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
          cli: stripped.cli,
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
        };

        return {
          savedDefaults: stripped,
          workspaceDefaults: wsKey
            ? { ...s.workspaceDefaults, [wsKey]: wsDefaults }
            : s.workspaceDefaults,
        };
      }),

      setWorkspaceNotes: (key, notes) => set((s) => {
        if (!key) return s;
        const next = { ...s.workspaceNotes };
        if (notes.length === 0) {
          delete next[key];
        } else {
          next[key] = notes;
        }
        return { workspaceNotes: next };
      }),

      setShowLauncher: (show) => set((s) => ({
        showLauncher: show,
        ...(show ? { launcherGeneration: s.launcherGeneration + 1 } : {}),
      })),

      setThemeName: (name) => set({ themeName: name }),

      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),
      setLastOpenedCliVersion: (cli, version) =>
        set((s) => ({
          lastOpenedCliVersions: { ...s.lastOpenedCliVersions, [cli]: version },
        })),

// [PE-01] cliCapabilitiesByCli, slashCommandsByCli, cliVersions per CliKind; v17 migration backfills from legacy fields; setCliCapabilitiesForCli mirrors Claude into legacy fields; setSlashCommandsForCli rebuilds merged slashCommands
      setCliCapabilitiesForCli: (cli, version, capabilities) =>
        set((s) => {
          const cliVersions = { ...s.cliVersions, [cli]: version };
          const previousCliVersions = {
            ...s.previousCliVersions,
            [cli]: s.cliVersions[cli],
          };
          const cliCapabilitiesByCli = {
            ...s.cliCapabilitiesByCli,
            [cli]: capabilities,
          };
          return {
            cliVersions,
            previousCliVersions,
            cliCapabilitiesByCli,
            // Back-compat for older call sites: keep Claude mirrored into the
            // legacy single-CLI fields until each consumer has moved over.
            ...(cli === "claude"
              ? {
                  previousCliVersion: s.cliVersion,
                  cliVersion: version,
                  cliCapabilities: capabilities,
                }
              : {}),
          };
        }),

      setCliCapabilities: (version, capabilities) =>
        get().setCliCapabilitiesForCli("claude", version, capabilities),

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

      setSlashCommandsForCli: (cli, cmds) =>
        set((s) => {
          const slashCommandsByCli = { ...s.slashCommandsByCli, [cli]: cmds };
          const merged = [
            ...slashCommandsByCli.claude,
            ...slashCommandsByCli.codex,
          ];
          return {
            slashCommandsByCli,
            slashCommands: merged,
          };
        }),
      setSlashCommands: (cmds) => set((s) => ({
        slashCommands: cmds,
        slashCommandsByCli: { ...s.slashCommandsByCli, claude: cmds },
      })),
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
            cli: config.cli === "codex" ? config.cli : undefined,
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
          // [SL-08] Prune sessionNames and sessionConfigs to only IDs present in loaded sessions
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
        await get().loadBinarySettingsFieldsForCli("claude");
      },
      loadSettingsJsonSchema: async () => {
        await get().loadSettingsSchemaForCli("claude");
      },
      loadKnownEnvVars: async (cliPath) => {
        await get().loadKnownEnvVarsForCli("claude", cliPath);
      },
      // [PE-02] Per-CLI binary scan for setting fields. Claude path is the
      // legacy `discover_settings_schema` (Zod regex over the .js bundle).
      // Codex emits its full schema as JSON Schema; that lives in the
      // settingsSchemaByCli slot rather than here, so this loader is a
      // no-op for Codex (kept for symmetry).
      loadBinarySettingsFieldsForCli: async (cli, cliPath) => {
        if (cli === "codex") {
          // Codex has no Zod-style "fields" extraction — its schema is the
          // canonical source loaded by loadSettingsSchemaForCli("codex").
          return;
        }
        try {
          const path = cliPath ?? useSessionStore.getState().claudePath;
          dlog("discovery", null, `binary settings-schema discovery started for ${cli}`, "DEBUG", {
            event: "discovery.settings_schema_started",
            data: { cli, cliPath: path ?? null },
          });
          const fields = await traceAsync("discovery.discover_settings_schema", () => invoke<BinarySettingField[]>("discover_settings_schema", { cliPath: path ?? null }), {
            module: "discovery",
            event: "discovery.settings_schema_perf",
            warnAboveMs: 1000,
            data: { cli, cliPath: path ?? null },
          });
          set((s) => ({
            binarySettingsFieldsByCli: { ...s.binarySettingsFieldsByCli, [cli]: fields },
            binarySettingsSchema: fields, // Mirror into legacy field for one version
          }));
          dlog("discovery", null, `binary settings-schema discovery completed for ${cli}`, "LOG", {
            event: "discovery.settings_schema_loaded",
            data: {
              cli,
              count: fields.length,
              keys: fields.map((field) => field.key),
              cliPath: path ?? null,
            },
          });
        } catch (err) {
          dlog("discovery", null, `binary settings-schema discovery failed for ${cli}: ${err}`, "WARN", {
            event: "discovery.settings_schema_failed",
            data: { cli, error: String(err) },
          });
        }
      },
      // [PE-02] Per-CLI JSON Schema fetch. Claude pulls schemastore.org via
      // the existing fetch_settings_schema Tauri command (reqwest, avoids
      // CORS). Codex extracts the embedded Draft-07 schema from the
      // installed native binary via discover_codex_settings_schema (Phase 2).
      loadSettingsSchemaForCli: async (cli, cliPath) => {
        try {
          dlog("discovery", null, `settings JSON schema fetch started for ${cli}`, "DEBUG", {
            event: "discovery.settings_json_schema_started",
            data: { cli },
          });
          let schema: JsonSchema | null = null;
          if (cli === "claude") {
            const raw = await traceAsync("discovery.fetch_settings_schema", () => invoke<string>("fetch_settings_schema"), {
              module: "discovery",
              event: "discovery.settings_json_schema_perf",
              warnAboveMs: 1000,
              data: { cli },
            });
            schema = JSON.parse(raw) as JsonSchema;
          } else {
            const path = cliPath ?? useSessionStore.getState().codexPath;
            schema = await traceAsync("discovery.discover_codex_settings_schema", () => invoke<JsonSchema>("discover_codex_settings_schema", { cliPath: path ?? null }), {
              module: "discovery",
              event: "discovery.settings_json_schema_perf",
              warnAboveMs: 5000,
              data: { cli, cliPath: path ?? null },
            });
          }
          set((s) => ({
            settingsSchemaByCli: { ...s.settingsSchemaByCli, [cli]: schema },
            ...(cli === "claude" ? { settingsJsonSchema: schema } : {}),
          }));
          const schemaTitle = schema && "title" in (schema as Record<string, unknown>)
            ? ((schema as Record<string, unknown>).title as string | undefined) ?? null
            : null;
          dlog("discovery", null, `settings JSON schema fetch completed for ${cli}`, "LOG", {
            event: "discovery.settings_json_schema_loaded",
            data: {
              cli,
              title: schemaTitle,
              hasProperties: !!schema?.properties,
              topLevelPropertyCount: schema?.properties ? Object.keys(schema.properties).length : 0,
            },
          });
        } catch (err) {
          dlog("discovery", null, `settings JSON schema fetch failed for ${cli}: ${err}`, "WARN", {
            event: "discovery.settings_json_schema_failed",
            data: { cli, error: String(err) },
          });
        }
      },
      // [PE-02] Per-CLI env var catalog. Claude scans the .js bundle for
      // process.env.* references; Codex scans the native binary for
      // CODEX_* string literals plus a curated catalog of non-prefixed
      // vars (OPENAI_API_KEY, SSL_CERT_FILE, …) via Phase 2's
      // discover_codex_env_vars.
      loadKnownEnvVarsForCli: async (cli, cliPath) => {
        try {
          const path = cliPath ?? (cli === "codex"
            ? useSessionStore.getState().codexPath
            : useSessionStore.getState().claudePath);
          dlog("discovery", null, `environment-variable discovery started for ${cli}`, "DEBUG", {
            event: "discovery.env_vars_started",
            data: { cli, cliPath: path ?? null },
          });
          const command = cli === "codex" ? "discover_codex_env_vars" : "discover_env_vars";
          const vars = await traceAsync(`discovery.${command}`, () => invoke<EnvVarEntry[]>(command, { cliPath: path ?? null }), {
            module: "discovery",
            event: "discovery.env_vars_perf",
            warnAboveMs: 1000,
            data: { cli, cliPath: path ?? null },
          });
          set((s) => ({
            knownEnvVarsByCli: { ...s.knownEnvVarsByCli, [cli]: vars },
            ...(cli === "claude" ? { knownEnvVars: vars } : {}),
          }));
          dlog("discovery", null, `environment-variable discovery completed for ${cli}`, "LOG", {
            event: "discovery.env_vars_loaded",
            data: {
              cli,
              count: vars.length,
              names: vars.map((variable) => variable.name),
              cliPath: path ?? null,
            },
          });
        } catch (err) {
          dlog("discovery", null, `environment-variable discovery failed for ${cli}: ${err}`, "WARN", {
            event: "discovery.env_vars_failed",
            data: { cli, error: String(err) },
          });
        }
      },

      addObservedPrompt: (text, model, cli = "claude") => set((s) => {
        if (s.observedPrompts.some((p) => p.text === text && (p.cli ?? "claude") === cli)) return s;
        const label = text.slice(0, 60).replace(/\n/g, " ").trim() + (text.length > 60 ? "..." : "");
        const entry: ObservedPrompt = {
          id: crypto.randomUUID(), cli, text, model, firstSeenAt: Date.now(), label,
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

      setRecordingConfig: (config) => set((s) => {
        const next = mergeRecordingConfig(s.recordingConfig, config);
        return {
          recordingConfig: next,
          recordingConfigsByCli: {
            ...s.recordingConfigsByCli,
            claude: next,
          },
        };
      }),

      setRecordingConfigForCli: (cli, config) => set((s) => {
        const current = getRecordingConfigForCliFromState(s, cli);
        const next = mergeRecordingConfig(current, config);
        return {
          recordingConfig: cli === "claude" ? next : s.recordingConfig,
          recordingConfigsByCli: {
            ...s.recordingConfigsByCli,
            [cli]: next,
          },
        };
      }),

      toggleNoisyEventKind: (kind) => set((s) => {
        const current = s.recordingConfig.noisyEventKinds;
        const next = current.includes(kind)
          ? current.filter((k) => k !== kind)
          : [...current, kind].sort();
        const recordingConfig = { ...s.recordingConfig, noisyEventKinds: next };
        return {
          recordingConfig,
          recordingConfigsByCli: {
            ...s.recordingConfigsByCli,
            claude: recordingConfig,
          },
        };
      }),

      toggleNoisyEventKindForCli: (cli, kind) => set((s) => {
        const currentConfig = getRecordingConfigForCliFromState(s, cli);
        const current = currentConfig.noisyEventKinds;
        const nextKinds = current.includes(kind)
          ? current.filter((k) => k !== kind)
          : [...current, kind].sort();
        const nextConfig = { ...currentConfig, noisyEventKinds: nextKinds };
        return {
          recordingConfig: cli === "claude" ? nextConfig : s.recordingConfig,
          recordingConfigsByCli: {
            ...s.recordingConfigsByCli,
            [cli]: nextConfig,
          },
        };
      }),
    }),
    {
      name: "code-tabs-settings",
      version: 22,
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
          // v9 used to convert routes -> providerConfig.providers. Provider
          // config is gone; persisted providerConfig keys are silently
          // dropped on load (zustand ignores unknown fields).
        }
        if (version < 14) {
          // v14 added compressionEnabled; field removed in v17.
        }
        if (version < 15) {
          // activityViewMode was promoted to a top-level tab (rightPanelTab "response"|"session").
          // rightPanelTab is transient (not persisted), so only clean up the stale key.
          delete state.activityViewMode;
        }
        // [NP-02] v16 migration backfills workspaceNotes as {} for older persisted states
        if (version < 16) {
          if (!state.workspaceNotes) state.workspaceNotes = {};
        }
        // v17: split formerly global CLI state into first-party Claude/Codex maps.
        if (version < 17) {
          const legacyVersion = (state.cliVersion as string | null | undefined) ?? null;
          const legacyPrevious = (state.previousCliVersion as string | null | undefined) ?? null;
          const legacyCapabilities = (state.cliCapabilities as CliCapabilities | undefined) ?? EMPTY_CLI_CAPABILITIES;
          const legacySlashCommands = (state.slashCommands as SlashCommand[] | undefined) ?? [];
          if (!state.cliVersions) state.cliVersions = { claude: legacyVersion, codex: null };
          if (!state.previousCliVersions) state.previousCliVersions = { claude: legacyPrevious, codex: null };
          if (!state.cliCapabilitiesByCli) {
            state.cliCapabilitiesByCli = {
              claude: legacyCapabilities,
              codex: EMPTY_CLI_CAPABILITIES,
            };
          }
          if (!state.slashCommandsByCli) state.slashCommandsByCli = { claude: legacySlashCommands, codex: [] };
          const lastConfig = state.lastConfig as Partial<SessionConfig> | undefined;
          if (lastConfig && !lastConfig.cli) lastConfig.cli = "claude";
          const savedDefaults = state.savedDefaults as Partial<SessionConfig> | undefined;
          if (savedDefaults && !savedDefaults.cli) savedDefaults.cli = "claude";
          const workspaceDefaults = state.workspaceDefaults as Record<string, Partial<SessionConfig>> | undefined;
          if (workspaceDefaults) {
            for (const ws of Object.values(workspaceDefaults)) {
              if (!ws.cli) ws.cli = "claude";
            }
          }
        }
        if (version < 18) {
          const rc = state.recordingConfig as { taps?: { categories?: Record<string, boolean> } } | undefined;
          if (rc?.taps?.categories) {
            for (const [key, enabled] of Object.entries(DEFAULT_RECORDING_CONFIG.taps.categories)) {
              if (key.startsWith("codex-") && rc.taps.categories[key] === undefined) {
                rc.taps.categories[key] = enabled;
              }
            }
          }
        }
        if (version < 19) {
          const legacy = cloneRecordingConfig(
            (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG,
          );
          state.recordingConfig = legacy;
          state.recordingConfigsByCli = {
            claude: cloneRecordingConfig(legacy),
            codex: cloneRecordingConfig(legacy),
          };
        } else {
          const byCli = state.recordingConfigsByCli as Partial<RecordingConfigsByCli> | undefined;
          state.recordingConfigsByCli = {
            claude: cloneRecordingConfig(byCli?.claude ?? (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG),
            codex: cloneRecordingConfig(byCli?.codex ?? (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG),
          };
          state.recordingConfig = (state.recordingConfigsByCli as RecordingConfigsByCli).claude;
        }
        if (version < 20) {
          const versions = state.cliVersions as Partial<Record<CliKind, string | null>> | undefined;
          state.lastOpenedCliVersions = {
            claude: versions?.claude ?? (state.cliVersion as string | null | undefined) ?? null,
            codex: versions?.codex ?? null,
          };
        } else if (!state.lastOpenedCliVersions) {
          state.lastOpenedCliVersions = { claude: null, codex: null };
        }
        if (version < 21) {
          const byCli = state.recordingConfigsByCli as Partial<RecordingConfigsByCli> | undefined;
          state.recordingConfigsByCli = {
            claude: quietRecordingConfig(byCli?.claude ?? (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG),
            codex: quietRecordingConfig(byCli?.codex ?? (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG),
          };
          state.recordingConfig = (state.recordingConfigsByCli as RecordingConfigsByCli).claude;
        }
        // [PE-02] v22: split formerly Claude-only schema/env-var caches
        // into per-CLI maps. Backfill the .claude slot from the legacy
        // fields so the existing Claude UI is uninterrupted; .codex starts
        // empty and is populated on first Codex session via
        // loadSettingsSchemaForCli("codex") / loadKnownEnvVarsForCli("codex").
        if (version < 22) {
          const legacyBinaryFields = (state.binarySettingsSchema as BinarySettingField[] | undefined) ?? [];
          const legacyJsonSchema = (state.settingsJsonSchema as JsonSchema | null | undefined) ?? null;
          const legacyEnvVars = (state.knownEnvVars as EnvVarEntry[] | undefined) ?? [];
          if (!state.binarySettingsFieldsByCli) {
            state.binarySettingsFieldsByCli = { claude: legacyBinaryFields, codex: [] };
          }
          if (!state.settingsSchemaByCli) {
            state.settingsSchemaByCli = { claude: legacyJsonSchema, codex: null };
          }
          if (!state.knownEnvVarsByCli) {
            state.knownEnvVarsByCli = { claude: legacyEnvVars, codex: [] };
          }
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
        workspaceNotes: state.workspaceNotes,
        themeName: state.themeName,
        notificationsEnabled: state.notificationsEnabled,
        cliVersions: state.cliVersions,
        lastOpenedCliVersions: state.lastOpenedCliVersions,
        previousCliVersions: state.previousCliVersions,
        cliVersion: state.cliVersion,
        previousCliVersion: state.previousCliVersion,
        cliCapabilitiesByCli: state.cliCapabilitiesByCli,
        cliCapabilities: state.cliCapabilities,
        binarySettingsFieldsByCli: state.binarySettingsFieldsByCli,
        settingsSchemaByCli: state.settingsSchemaByCli,
        knownEnvVarsByCli: state.knownEnvVarsByCli,
        binarySettingsSchema: state.binarySettingsSchema,
        settingsJsonSchema: state.settingsJsonSchema,
        slashCommandsByCli: state.slashCommandsByCli,
        commandUsage: state.commandUsage,
        commandBarExpanded: state.commandBarExpanded,
        sessionNames: state.sessionNames,
        sessionConfigs: state.sessionConfigs,
        savedPrompts: state.savedPrompts,
        systemPromptRules: state.systemPromptRules,
        modelRegistry: state.modelRegistry,
        recordingConfig: state.recordingConfig,
        recordingConfigsByCli: state.recordingConfigsByCli,
      }),
    }
  )
);

// Sync debug capture flag into the zero-import debugLog module
function resolveDebugCaptureForSession(sessionId: string | null): boolean {
  const settings = useSettingsStore.getState();
  if (!sessionId) {
    return settings.recordingConfigsByCli.claude.debugCapture || settings.recordingConfigsByCli.codex.debugCapture;
  }
  const sessionState = useSessionStore.getState();
  const session = sessionState.sessions?.find((s) => s.id === sessionId);
  const cached = settings.sessionConfigs[sessionId]?.cli;
  const cli = session?.config.cli ?? cached ?? "claude";
  return getRecordingConfigForCliFromState(settings, cli).debugCapture;
}

let _prevDebugCapture = useSettingsStore.getState().recordingConfigsByCli.claude.debugCapture;
setDebugCaptureEnabled(_prevDebugCapture);
setDebugCaptureResolver(resolveDebugCaptureForSession);
useSettingsStore.subscribe((state) => {
  const next = state.recordingConfigsByCli.claude.debugCapture;
  if (next !== _prevDebugCapture) {
    _prevDebugCapture = next;
    setDebugCaptureEnabled(next);
  }
});
