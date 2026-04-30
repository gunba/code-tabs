import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  configureObservability,
  startObservabilityBridge,
  stopObservabilityBridge,
  type ObservabilityInfo,
} from "../lib/debugLog";
import { startFrontendPerfTelemetry, stopFrontendPerfTelemetry } from "../lib/perfTelemetry";

const DEFAULT_OBSERVABILITY_INFO: ObservabilityInfo = {
  observabilityEnabled: false,
  runtimeOverride: false,
  devtoolsEnabled: false,
  globalLogPath: null,
  globalLogSize: 0,
  globalRotationCount: 0,
  minLevel: "DEBUG",
};

interface RuntimeState {
  observabilityInfo: ObservabilityInfo;
  loaded: boolean;
  loadRuntimeInfo: () => Promise<void>;
  openMainDevtools: () => Promise<void>;
  setObservabilityEnabled: (enabled: boolean) => Promise<void>;
  setDevtoolsEnabled: (enabled: boolean) => Promise<void>;
}

export const useRuntimeStore = create<RuntimeState>((set) => ({
  observabilityInfo: DEFAULT_OBSERVABILITY_INFO,
  loaded: false,

  loadRuntimeInfo: async () => {
    try {
      const info = await invoke<ObservabilityInfo>("get_observability_info");
      await applyObservabilityInfo(info, set);
    } catch {
      configureObservability(DEFAULT_OBSERVABILITY_INFO);
      stopObservabilityBridge();
      stopFrontendPerfTelemetry();
      set({ observabilityInfo: DEFAULT_OBSERVABILITY_INFO, loaded: true });
    }
  },

  openMainDevtools: async () => {
    await invoke("open_main_devtools");
  },

  setObservabilityEnabled: async (enabled: boolean) => {
    const info = await invoke<ObservabilityInfo>("set_observability_enabled", { enabled });
    await applyObservabilityInfo(info, set);
  },

  setDevtoolsEnabled: async (enabled: boolean) => {
    const info = await invoke<ObservabilityInfo>("set_devtools_enabled", { enabled });
    await applyObservabilityInfo(info, set);
  },
}));

async function applyObservabilityInfo(
  info: ObservabilityInfo,
  set: (partial: Partial<RuntimeState>) => void,
): Promise<void> {
  configureObservability(info);
  set({ observabilityInfo: info, loaded: true });
  if (info.observabilityEnabled) {
    await startObservabilityBridge();
    startFrontendPerfTelemetry();
  } else {
    stopObservabilityBridge();
    stopFrontendPerfTelemetry();
  }
}
