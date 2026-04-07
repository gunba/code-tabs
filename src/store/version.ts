// [VA-01] Version store: build info, app update, CLI version check, CLI update
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { dlog } from "../lib/debugLog";

interface BuildInfo {
  appVersion: string;
  claudeCodeBuildVersion: string;
}

interface CliUpdateResult {
  method: string;
  success: boolean;
  message: string;
}

interface VersionState {
  // Build info (loaded once)
  appVersion: string | null;
  claudeCodeBuildVersion: string | null;

  // Latest versions (fetched periodically)
  latestCliVersion: string | null;

  // App update state
  appUpdate: Update | null;
  appUpdateDownloading: boolean;
  appUpdateProgress: number;

  // CLI update state
  cliUpdating: boolean;

  // Actions
  loadBuildInfo: () => Promise<void>;
  checkForAppUpdate: () => Promise<void>;
  downloadAndInstallAppUpdate: () => Promise<void>;
  checkLatestCliVersion: () => Promise<void>;
  updateCli: () => Promise<CliUpdateResult | null>;
}

export const useVersionStore = create<VersionState>((set, get) => ({
  appVersion: null,
  claudeCodeBuildVersion: null,
  latestCliVersion: null,
  appUpdate: null,
  appUpdateDownloading: false,
  appUpdateProgress: 0,
  cliUpdating: false,

  loadBuildInfo: async () => {
    try {
      const info = await invoke<BuildInfo>("get_build_info");
      set({
        appVersion: info.appVersion,
        claudeCodeBuildVersion: info.claudeCodeBuildVersion,
      });
      dlog("version", null, `Build info: app=${info.appVersion}, cc=${info.claudeCodeBuildVersion}`, "LOG", {
        event: "version.build_info_loaded",
        data: info,
      });
    } catch (err) {
      dlog("version", null, `Failed to load build info: ${err}`, "WARN");
    }
  },

  checkForAppUpdate: async () => {
    try {
      const update = await check();
      if (update) {
        set({ appUpdate: update });
        dlog("version", null, `App update available: ${update.version}`, "LOG", {
          event: "version.app_update_available",
          data: { version: update.version, date: update.date, body: update.body },
        });
      }
    } catch (err) {
      dlog("version", null, `App update check failed: ${err}`, "WARN", {
        event: "version.app_update_check_failed",
        data: { error: String(err) },
      });
    }
  },

  downloadAndInstallAppUpdate: async () => {
    const { appUpdate } = get();
    if (!appUpdate) return;

    set({ appUpdateDownloading: true, appUpdateProgress: 0 });
    try {
      let contentLength = 0;
      let downloaded = 0;
      await appUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            dlog("version", null, `Update download started: ${contentLength} bytes`, "LOG");
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              set({ appUpdateProgress: Math.round((downloaded / contentLength) * 100) });
            }
            break;
          case "Finished":
            set({ appUpdateProgress: 100 });
            dlog("version", null, "Update download finished", "LOG");
            break;
        }
      });
      dlog("version", null, "Update installed, relaunching", "LOG");
      await relaunch();
    } catch (err) {
      set({ appUpdateDownloading: false, appUpdateProgress: 0 });
      dlog("version", null, `Update download/install failed: ${err}`, "ERR", {
        event: "version.app_update_failed",
        data: { error: String(err) },
      });
    }
  },

  checkLatestCliVersion: async () => {
    try {
      const version = await invoke<string>("check_latest_cli_version");
      set({ latestCliVersion: version });
      dlog("version", null, `Latest CLI version: ${version}`, "LOG", {
        event: "version.latest_cli_version",
        data: { version },
      });
    } catch (err) {
      dlog("version", null, `CLI version check failed: ${err}`, "WARN", {
        event: "version.cli_version_check_failed",
        data: { error: String(err) },
      });
    }
  },

  updateCli: async () => {
    set({ cliUpdating: true });
    try {
      const result = await invoke<CliUpdateResult>("update_cli");
      dlog("version", null, `CLI update (${result.method}): ${result.success ? "success" : "failed"} — ${result.message}`, result.success ? "LOG" : "WARN", {
        event: "version.cli_update_result",
        data: result,
      });
      set({ cliUpdating: false });
      return result;
    } catch (err) {
      dlog("version", null, `CLI update invocation failed: ${err}`, "ERR");
      set({ cliUpdating: false });
      return null;
    }
  },
}));
