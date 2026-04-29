import type {
  CliKind,
  LaunchPreset,
  PastSession,
  SessionConfig,
  SystemPromptRule,
} from "../../types/session";
import type { BinarySettingField, JsonSchema } from "../../lib/settingsSchema";
import type { EnvVarEntry } from "../../lib/envVars";
import type { ModelRegistryEntry } from "../../lib/claude";
import type { CliCapabilities, SlashCommand } from "./discovery";
import type { RecordingConfig, RecordingConfigsByCli } from "./recording";

export interface ObservedPrompt {
  id: string;
  cli: CliKind;
  text: string;
  model: string;
  firstSeenAt: number;
  label: string;
}

export interface SettingsState {
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
  /** When true, Codex tabs auto-rename on first user message via a small OpenAI model. */
  codexAutoRenameLLMEnabled: boolean;
  /** Model passed to `codex exec --model` for auto-rename. Free text - Codex accepts any model string. */
  codexAutoRenameLLMModel: string;
  cliVersions: Record<CliKind, string | null>;
  lastOpenedCliVersions: Record<CliKind, string | null>;
  previousCliVersions: Record<CliKind, string | null>;
  cliCapabilitiesByCli: Record<CliKind, CliCapabilities>;
  // [PE-02] Per-CLI discovery state. Settings schemas are runtime-only;
  // env vars and binary fields remain persisted discovery outputs.
  binarySettingsFieldsByCli: Record<CliKind, BinarySettingField[]>;
  settingsSchemaByCli: Record<CliKind, JsonSchema | null>;
  knownEnvVarsByCli: Record<CliKind, EnvVarEntry[]>;
  slashCommandsByCli: Record<CliKind, SlashCommand[]>;

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
  setCodexAutoRenameLLMEnabled: (enabled: boolean) => void;
  setCodexAutoRenameLLMModel: (model: string) => void;
  setLastOpenedCliVersion: (cli: CliKind, version: string | null) => void;
  setCliCapabilitiesForCli: (cli: CliKind, version: string | null, capabilities: CliCapabilities) => void;
  recordCommandUsage: (command: string) => void;
  setSlashCommandsForCli: (cli: CliKind, cmds: SlashCommand[]) => void;
  setReplaceSessionId: (id: string | null) => void;
  setShowConfigManager: (show: string | false) => void;
  setCommandBarExpanded: (expanded: boolean) => void;
  setRightPanelTab: (panel: "debug" | "response" | "session" | "notes" | "search") => void;
  bootstrapCommandUsage: () => Promise<void>;
  triggerCommandRefresh: () => void;
  setSessionName: (id: string, name: string) => void;
  cacheSessionConfig: (id: string, config: SessionConfig) => void;
  loadPastSessions: () => Promise<void>;
  loadBinarySettingsFieldsForCli: (cli: CliKind, cliPath?: string | null) => Promise<void>;
  loadSettingsSchemaForCli: (cli: CliKind, cliPath?: string | null) => Promise<void>;
  loadKnownEnvVarsForCli: (cli: CliKind, cliPath?: string | null) => Promise<void>;
  addObservedPrompt: (text: string, model: string, cli?: CliKind) => void;
  addSavedPrompt: (name: string, text: string) => void;
  updateSavedPrompt: (id: string, updates: { name?: string; text?: string }) => void;
  removeSavedPrompt: (id: string) => void;
  setProxyPort: (port: number | null) => void;
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
