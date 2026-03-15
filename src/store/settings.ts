import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { LaunchPreset, SessionConfig } from "../types/session";
import { DEFAULT_SESSION_CONFIG } from "../types/session";

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
  showLauncher: boolean;
  themeName: string;
  notificationsEnabled: boolean;
  cliVersion: string | null;
  previousCliVersion: string | null;
  cliCapabilities: CliCapabilities;
  slashCommands: SlashCommand[];

  commandUsage: Record<string, number>;
  showHooksManager: boolean;
  replaceSessionId: string | null; // Session to close when launcher launches (Shift+Click relaunch)

  // Actions
  addRecentDir: (dir: string) => void;
  savePreset: (name: string, config: Partial<SessionConfig>) => void;
  removePreset: (id: string) => void;
  setLastConfig: (config: SessionConfig) => void;
  setShowLauncher: (show: boolean) => void;
  setThemeName: (name: string) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setCliCapabilities: (version: string, capabilities: CliCapabilities) => void;
  recordCommandUsage: (command: string) => void;
  setSlashCommands: (cmds: SlashCommand[]) => void;
  setReplaceSessionId: (id: string | null) => void;
  setShowHooksManager: (show: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      recentDirs: [],
      presets: [],
      lastConfig: DEFAULT_SESSION_CONFIG,
      showLauncher: false,
      themeName: "Claude",
      notificationsEnabled: true,
      cliVersion: null,
      previousCliVersion: null,
      cliCapabilities: { models: [], permissionModes: [], flags: [], options: [], commands: [] },
      slashCommands: [],
      commandUsage: {},
      showHooksManager: false,
      replaceSessionId: null,

      addRecentDir: (dir) =>
        set((s) => ({
          recentDirs: [dir, ...s.recentDirs.filter((d) => d !== dir)].slice(0, 20),
        })),

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

      setLastConfig: (config) => set({ lastConfig: config }),

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
      setShowHooksManager: (show) => set({ showHooksManager: show }),
      setReplaceSessionId: (id) => set({ replaceSessionId: id }),
    }),
    {
      name: "claude-tabs-settings",
      storage: createJSONStorage(() => localStorage),
      // Don't persist transient UI state
      partialize: (state) => ({
        recentDirs: state.recentDirs,
        presets: state.presets,
        lastConfig: state.lastConfig,
        themeName: state.themeName,
        notificationsEnabled: state.notificationsEnabled,
        cliVersion: state.cliVersion,
        previousCliVersion: state.previousCliVersion,
        cliCapabilities: state.cliCapabilities,
        commandUsage: state.commandUsage,
      }),
    }
  )
);
