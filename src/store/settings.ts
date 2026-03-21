import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { LaunchPreset, SessionConfig, PastSession } from "../types/session";
import { DEFAULT_SESSION_CONFIG } from "../types/session";
import { normalizePath } from "../lib/paths";
import type { BinarySettingField } from "../lib/settingsSchema";

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

interface SettingsState {
  recentDirs: string[];
  presets: LaunchPreset[];
  lastConfig: SessionConfig;
  savedDefaults: SessionConfig | null;
  showLauncher: boolean;
  themeName: string;
  notificationsEnabled: boolean;
  cliVersion: string | null;
  previousCliVersion: string | null;
  cliCapabilities: CliCapabilities;
  binarySettingsSchema: BinarySettingField[];
  slashCommands: SlashCommand[];

  commandUsage: Record<string, number>;
  commandUsageBootstrapped: boolean;
  showConfigManager: string | false;
  showThinkingPanel: boolean;
  replaceSessionId: string | null; // Session to close when launcher launches (Ctrl+Click relaunch)
  pastSessions: PastSession[];
  pastSessionsLoading: boolean;
  sessionNames: Record<string, string>;
  sessionConfigs: Record<string, Partial<SessionConfig>>;

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
  setShowThinkingPanel: (show: boolean) => void;
  bootstrapCommandUsage: () => Promise<void>;
  setSessionName: (id: string, name: string) => void;
  cacheSessionConfig: (id: string, config: SessionConfig) => void;
  loadPastSessions: () => Promise<void>;
  loadBinarySettingsSchema: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      recentDirs: [],
      presets: [],
      lastConfig: DEFAULT_SESSION_CONFIG,
      savedDefaults: null,
      showLauncher: false,
      themeName: "Claude",
      notificationsEnabled: true,
      cliVersion: null,
      previousCliVersion: null,
      cliCapabilities: { models: [], permissionModes: [], flags: [], options: [], commands: [] },
      binarySettingsSchema: [],
      slashCommands: [],
      commandUsage: {},
      commandUsageBootstrapped: false,
      showConfigManager: false,
      showThinkingPanel: false,
      replaceSessionId: null,
      pastSessions: [],
      pastSessionsLoading: false,
      sessionNames: {},
      sessionConfigs: {},

      addRecentDir: (dir) =>
        set((s) => {
          const norm = normalizePath(dir);
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

      setShowLauncher: (show) => set({ showLauncher: show }),

      setThemeName: (name) => set({ themeName: name }),

      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),

      setCliCapabilities: (version, capabilities) =>
        set((s) => ({
          previousCliVersion: s.cliVersion,
          cliVersion: version,
          cliCapabilities: capabilities,
        })),

      recordCommandUsage: (command) =>
        set((s) => ({
          commandUsage: {
            ...s.commandUsage,
            [command]: (s.commandUsage[command] || 0) + 1,
          },
        })),

      setSlashCommands: (cmds) => set({ slashCommands: cmds }),
      setShowConfigManager: (show) => set({ showConfigManager: show }),
      setShowThinkingPanel: (show) => set({ showThinkingPanel: show }),
      bootstrapCommandUsage: async () => {
        try {
          const scanned = await invoke<Record<string, number>>("scan_command_usage");
          set((s) => {
            const merged = { ...s.commandUsage };
            for (const [cmd, count] of Object.entries(scanned)) {
              merged[cmd] = Math.max(merged[cmd] || 0, count);
            }
            return { commandUsage: merged, commandUsageBootstrapped: true };
          });
        } catch {
          set({ commandUsageBootstrapped: true });
        }
      },
      setReplaceSessionId: (id) => set({ replaceSessionId: id }),
      setSessionName: (id, name) =>
        set((s) => ({
          sessionNames: { ...s.sessionNames, [id]: name },
        })),
      cacheSessionConfig: (id, config) =>
        set((s) => {
          // Store only non-default fields to keep entries small
          const partial: Partial<SessionConfig> = {};
          if (config.model) partial.model = config.model;
          if (config.permissionMode !== "default") partial.permissionMode = config.permissionMode;
          if (config.effort) partial.effort = config.effort;
          if (config.agent) partial.agent = config.agent;
          if (config.maxBudget !== null) partial.maxBudget = config.maxBudget;
          if (config.runMode) partial.runMode = config.runMode;
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
          const fields = await invoke<BinarySettingField[]>("discover_settings_schema");
          set({ binarySettingsSchema: fields });
        } catch {
          // Binary scan failed — no problem, CLI help + static fields still work
        }
      },
    }),
    {
      name: "claude-tabs-settings",
      storage: createJSONStorage(() => localStorage),
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
        commandUsage: state.commandUsage,
        commandUsageBootstrapped: state.commandUsageBootstrapped,
        sessionNames: state.sessionNames,
        sessionConfigs: state.sessionConfigs,
      }),
    }
  )
);
