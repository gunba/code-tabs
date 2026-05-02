import type { CliKind, SessionConfig } from "../../types/session";
import type { BinarySettingField, JsonSchema } from "../../lib/settingsSchema";
import type { EnvVarEntry } from "../../lib/envVars";
import {
  cloneRecordingConfig,
  ensureNoisyEventKind,
  DEFAULT_CODEX_RECORDING_CONFIG,
  DEFAULT_NOISY_EVENT_KINDS,
  DEFAULT_RECORDING_CONFIG,
  type RecordingConfig,
  type RecordingConfigsByCli,
} from "./recording";
import {
  EMPTY_CLI_CAPABILITIES,
  type CliCapabilities,
  type SlashCommand,
} from "./discovery";

// [CI-04] Persisted settings migrations normalize providerConfig from v0 and extend later stored fields.
export function migrateSettings(persisted: unknown, version: number) {
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
      // Default stdout/stderr off - pure ANSI noise
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
  // v8->v9: Convert global routes to per-provider modelMappings, add kind/predefined fields
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
    const quiet = (config: RecordingConfig): RecordingConfig => {
      const cloned = cloneRecordingConfig(config);
      for (const [category, enabled] of Object.entries(DEFAULT_RECORDING_CONFIG.taps.categories)) {
        if (!enabled) cloned.taps.categories[category] = false;
      }
      cloned.taps.enabled = false;
      cloned.traffic.enabled = false;
      cloned.debugCapture = false;
      return cloned;
    };
    state.recordingConfigsByCli = {
      claude: quiet(byCli?.claude ?? (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG),
      codex: quiet(byCli?.codex ?? (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG),
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
  if (version < 23) {
    const byCli = state.recordingConfigsByCli as Partial<RecordingConfigsByCli> | undefined;
    const claude = cloneRecordingConfig(
      byCli?.claude ?? (state.recordingConfig as RecordingConfig | undefined) ?? DEFAULT_RECORDING_CONFIG,
    );
    const codex = ensureNoisyEventKind(
      cloneRecordingConfig(byCli?.codex ?? DEFAULT_CODEX_RECORDING_CONFIG),
      "CodexTokenCount",
    );
    state.recordingConfigsByCli = { claude, codex };
    state.recordingConfig = claude;
  }
  if (version < 24) {
    delete state.cliVersion;
    delete state.previousCliVersion;
    delete state.cliCapabilities;
    delete state.binarySettingsSchema;
    delete state.settingsJsonSchema;
    delete state.knownEnvVars;
    delete state.slashCommands;
  }
  if (version < 25) {
    // Settings schemas are runtime discovery results. Do not carry stale
    // persisted schemas across app starts; loaders repopulate these in-memory.
    state.settingsSchemaByCli = { claude: null, codex: null };
  }
  if (version < 26) {
    const rules = Array.isArray(state.systemPromptRules)
      ? state.systemPromptRules as Array<Record<string, unknown>>
      : [];
    state.systemPromptRules = rules.flatMap((rule, index) => {
      if (rule.cli === "claude" || rule.cli === "codex") return [rule];
      const id = typeof rule.id === "string" && rule.id.length > 0
        ? rule.id
        : `prompt-rule-${index}`;
      return [
        { ...rule, id, cli: "claude" },
        { ...rule, id: `${id}-codex`, cli: "codex" },
      ];
    });
  }
  return state;
}
