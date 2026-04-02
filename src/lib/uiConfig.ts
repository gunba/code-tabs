import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debugLog";

/**
 * Shared UI configuration stored at %LOCALAPPDATA%/claude-tabs/ui-config.json.
 * Loaded once at startup. Changes require app restart.
 */

export interface UiConfig {
  version: number;

  deadSessions: {
    maxAge: number; // Max age in days before auto-removing dead sessions
  };

  resume: {
    maxItems: number;
    showSize: boolean;
    showRelativeDate: boolean;
  };
}

export const DEFAULT_UI_CONFIG: UiConfig = {
  version: 2,

  deadSessions: {
    maxAge: 7,
  },

  resume: {
    maxItems: 12,
    showSize: true,
    showRelativeDate: true,
  },
};

// ── Zustand store for live config ────────────────────────────────────

interface UiConfigState {
  config: UiConfig;
  loaded: boolean;
  setConfig: (config: UiConfig) => void;
  loadConfig: () => Promise<void>;
}

export const useUiConfigStore = create<UiConfigState>((set) => ({
  config: DEFAULT_UI_CONFIG,
  loaded: false,

  setConfig: (config) => set({ config, loaded: true }),

  loadConfig: async () => {
    try {
      const content = await invoke<string>("read_ui_config");
      if (content) {
        const parsed = JSON.parse(content);
        const merged = deepMerge(
          DEFAULT_UI_CONFIG as unknown as Record<string, unknown>,
          parsed as Record<string, unknown>,
        ) as unknown as UiConfig;
        set({ config: merged, loaded: true });
      } else {
        await invoke("write_ui_config", {
          configJson: JSON.stringify(DEFAULT_UI_CONFIG, null, 2),
        });
        set({ config: DEFAULT_UI_CONFIG, loaded: true });
      }
    } catch (err) {
      dlog("config", null, `uiConfig load failed: ${err}`, "ERR");
      set({ config: DEFAULT_UI_CONFIG, loaded: true });
    }
  },
}));

// ── Deep merge utility ───────────────────────────────────────────────

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
