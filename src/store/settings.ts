import { create } from "zustand";
import { persist, createJSONStorage, subscribeWithSelector } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { SessionConfig, PastSession } from "../types/session";
import { DEFAULT_SESSION_CONFIG, pickWorkspaceFields } from "../types/session";
import { normalizePath, parseWorktreePath } from "../lib/paths";
import type { BinarySettingField, JsonSchema } from "../lib/settingsSchema";
import type { EnvVarEntry } from "../lib/envVars";
import type { ModelRegistryEntry } from "../lib/claude";
import { dlog, setDebugCaptureEnabled, setDebugCaptureResolver } from "../lib/debugLog";
import { traceAsync } from "../lib/perfTrace";
import { useSessionStore } from "./sessions";
import {
  defaultRecordingConfig,
  getRecordingConfigForCliFromState,
  mergeRecordingConfig,
} from "./settings/recording";
import { EMPTY_CLI_CAPABILITIES } from "./settings/discovery";
import { migrateSettings } from "./settings/migrations";
import { partializeSettings } from "./settings/partialize";
import type { ObservedPrompt, SettingsState } from "./settings/types";

export type { CliCapabilities, CliCommand, CliOption, SlashCommand } from "./settings/discovery";
export {
  DEFAULT_CODEX_NOISY_EVENT_KINDS,
  DEFAULT_CODEX_RECORDING_CONFIG,
  DEFAULT_NOISY_EVENT_KINDS,
  DEFAULT_RECORDING_CONFIG,
  DEFAULT_RECORDING_CONFIGS_BY_CLI,
  getRecordingConfigForCliFromState,
} from "./settings/recording";
export type { RecordingConfig, RecordingConfigsByCli } from "./settings/recording";
export type { ObservedPrompt, SettingsState } from "./settings/types";

function syncRulesToProxy() {
  const rules = useSettingsStore.getState().systemPromptRules;
  invoke("update_system_prompt_rules", { rules }).catch(() => {});
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector(
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
      codexAutoRenameLLMEnabled: true,
      codexAutoRenameLLMModel: "gpt-5-mini",
      cliVersions: { claude: null, codex: null },
      lastOpenedCliVersions: { claude: null, codex: null },
      previousCliVersions: { claude: null, codex: null },
      cliCapabilitiesByCli: {
        claude: EMPTY_CLI_CAPABILITIES,
        codex: EMPTY_CLI_CAPABILITIES,
      },
      binarySettingsFieldsByCli: { claude: [], codex: [] },
      settingsSchemaByCli: { claude: null, codex: null },
      knownEnvVarsByCli: { claude: [], codex: [] },
      slashCommandsByCli: { claude: [], codex: [] },
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
      systemPromptRules: [],
      modelRegistry: {},
      recordingConfig: defaultRecordingConfig(),
      recordingConfigsByCli: {
        claude: defaultRecordingConfig(),
        codex: defaultRecordingConfig("codex"),
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

        const wsDefaults = pickWorkspaceFields(stripped);

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
      setCodexAutoRenameLLMEnabled: (enabled) => set({ codexAutoRenameLLMEnabled: enabled }),
      setCodexAutoRenameLLMModel: (model) => set({ codexAutoRenameLLMModel: model }),
      setLastOpenedCliVersion: (cli, version) =>
        set((s) => ({
          lastOpenedCliVersions: { ...s.lastOpenedCliVersions, [cli]: version },
        })),

// [PE-01] cliCapabilitiesByCli, slashCommandsByCli, cliVersions per CliKind; v17 migration backfills from legacy fields.
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
          };
        }),

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
          return {
            slashCommandsByCli,
          };
        }),
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
          const partial = pickWorkspaceFields(config);
          // Strip undefined/null/default values to keep entries small
          for (const [k, v] of Object.entries(partial)) {
            if (
              v === undefined ||
              v === null ||
              v === false ||
              v === "" ||
              v === "default" ||
              (Array.isArray(v) && v.length === 0)
            ) {
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
      // [PE-02] [CM-10] Per-CLI JSON Schema fetch. Claude pulls schemastore.org via
      // the existing fetch_settings_schema Tauri command (reqwest, avoids
      // CORS). Codex asks the backend to mine the installed binary first, then
      // fetch the matching openai/codex release schema at runtime.
      loadSettingsSchemaForCli: async (cli, cliPath) => {
        try {
          dlog("discovery", null, `settings JSON schema fetch started for ${cli}`, "DEBUG", {
            event: "discovery.settings_json_schema_started",
            data: { cli },
          });
          let schema: JsonSchema | null = null;
          let codexSchemaSource: "binary" | "remote" | null = null;
          let codexSchemaVersion: string | null = null;
          let codexSchemaUrl: string | null = null;
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
            // Backend returns CodexSchemaResult { schema, source, version?, url? }; unwrap to the schema.
            const result = await traceAsync(
              "discovery.discover_codex_settings_schema",
              () => invoke<{ schema: JsonSchema; source: "binary" | "remote"; version?: string; url?: string }>(
                "discover_codex_settings_schema",
                { cliPath: path ?? null },
              ),
              {
                module: "discovery",
                event: "discovery.settings_json_schema_perf",
                warnAboveMs: 5000,
                data: { cli, cliPath: path ?? null },
              },
            );
            schema = result.schema;
            codexSchemaSource = result.source;
            codexSchemaVersion = result.version ?? null;
            codexSchemaUrl = result.url ?? null;
          }
          set((s) => ({
            settingsSchemaByCli: { ...s.settingsSchemaByCli, [cli]: schema },
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
              codexSchemaSource,
              codexSchemaVersion,
              codexSchemaUrl,
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

      // [CM-35] Prompt rewrite rules are CLI-scoped; migration v26 duplicates legacy unscoped rules.
      addSystemPromptRule: (cli = "claude") => set((s) => ({
        systemPromptRules: [...s.systemPromptRules, {
          id: crypto.randomUUID(),
          cli,
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
          const cli = s.systemPromptRules[idx].cli ?? "claude";
          const scopedIndexes = s.systemPromptRules
            .map((rule, index) => ({ rule, index }))
            .filter(({ rule }) => (rule.cli ?? "claude") === cli);
          const scopedIdx = scopedIndexes.findIndex(({ index }) => index === idx);
          if (scopedIdx < 0) return s;
          const scopedTarget = scopedIdx + direction;
          if (scopedTarget < 0 || scopedTarget >= scopedIndexes.length) return s;
          const target = scopedIndexes[scopedTarget].index;
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
      version: 26,
      storage: createJSONStorage(() => localStorage),
      migrate: migrateSettings,
      // Don't persist transient UI state
      partialize: partializeSettings,
      }
    )
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

const selectAnyDebugCaptureEnabled = (state: SettingsState) =>
  state.recordingConfigsByCli.claude.debugCapture || state.recordingConfigsByCli.codex.debugCapture;

setDebugCaptureEnabled(selectAnyDebugCaptureEnabled(useSettingsStore.getState()));
setDebugCaptureResolver(resolveDebugCaptureForSession);
useSettingsStore.subscribe(selectAnyDebugCaptureEnabled, setDebugCaptureEnabled);
