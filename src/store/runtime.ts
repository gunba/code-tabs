import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  configureObservability,
  startObservabilityBridge,
  type ObservabilityInfo,
} from "../lib/debugLog";

const DEFAULT_OBSERVABILITY_INFO: ObservabilityInfo = {
  debugBuild: false,
  observabilityEnabled: false,
  devtoolsAvailable: false,
  globalLogPath: null,
};

interface RuntimeState {
  observabilityInfo: ObservabilityInfo;
  loaded: boolean;
  hasExecutedSearch: boolean;
  loadRuntimeInfo: () => Promise<void>;
  openMainDevtools: () => Promise<void>;
  markSearchExecuted: () => void;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  observabilityInfo: DEFAULT_OBSERVABILITY_INFO,
  loaded: false,
  hasExecutedSearch: false,

  loadRuntimeInfo: async () => {
    try {
      const info = await invoke<ObservabilityInfo>("get_observability_info");
      configureObservability(info);
      set({ observabilityInfo: info, loaded: true });
      if (info.observabilityEnabled) {
        await startObservabilityBridge();
      }
    } catch {
      configureObservability(DEFAULT_OBSERVABILITY_INFO);
      set({ observabilityInfo: DEFAULT_OBSERVABILITY_INFO, loaded: true });
    }
  },

  openMainDevtools: async () => {
    await invoke("open_main_devtools");
  },

  markSearchExecuted: () => {
    if (!get().hasExecutedSearch) set({ hasExecutedSearch: true });
  },
}));
