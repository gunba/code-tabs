import { useVersionStore } from "../../store/version";
import { useSettingsStore } from "../../store/settings";
import { invoke } from "@tauri-apps/api/core";
import "./AppHeader.css";

function newerThan(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

export function AppHeader() {
  const appVersion = useVersionStore((s) => s.appVersion);
  const claudeCodeBuildVersion = useVersionStore((s) => s.claudeCodeBuildVersion);
  const appUpdate = useVersionStore((s) => s.appUpdate);
  const appUpdateDownloading = useVersionStore((s) => s.appUpdateDownloading);
  const appUpdateProgress = useVersionStore((s) => s.appUpdateProgress);
  const downloadAndInstallAppUpdate = useVersionStore((s) => s.downloadAndInstallAppUpdate);
  const latestCliVersion = useVersionStore((s) => s.latestCliVersion);
  const cliUpdating = useVersionStore((s) => s.cliUpdating);
  const updateCli = useVersionStore((s) => s.updateCli);
  const cliVersion = useSettingsStore((s) => s.cliVersion);

  const cliUpdateAvailable = newerThan(latestCliVersion, cliVersion);

  return (
    <div className="app-header">
      <span className="app-header-brand">Claude Tabs</span>
      {appVersion && (
        <span className="app-header-version">{appVersion}</span>
      )}
      {appUpdate && (
        <button
          className="app-header-update-btn"
          disabled={appUpdateDownloading}
          onClick={downloadAndInstallAppUpdate}
          title={appUpdate.body || `Update to ${appUpdate.version}`}
        >
          {appUpdateDownloading
            ? `Updating ${appUpdateProgress}%`
            : `Update to ${appUpdate.version}`}
        </button>
      )}

      <span className="app-header-sep">&middot;</span>

      <span className="app-header-label">Built for Claude Code</span>
      <span className="app-header-cli-version">
        {claudeCodeBuildVersion && claudeCodeBuildVersion !== "unknown"
          ? claudeCodeBuildVersion
          : "..."}
      </span>

      <span className="app-header-sep">&middot;</span>

      <span className="app-header-label">Running Claude Code</span>
      <span className="app-header-cli-version">
        {cliVersion || "..."}
      </span>
      {cliUpdateAvailable && (
        <button
          className={`app-header-update-btn${cliUpdating ? " updating" : ""}`}
          disabled={cliUpdating}
          onClick={async () => {
            const result = await updateCli();
            if (result?.success) {
              // Re-check the CLI version to refresh the display
              invoke("check_cli_version")
                .then((v) => {
                  if (typeof v === "string") {
                    useSettingsStore.getState().setCliCapabilities(v, useSettingsStore.getState().cliCapabilities);
                  }
                })
                .catch(() => {});
              // Re-check latest version
              useVersionStore.getState().checkLatestCliVersion();
            }
          }}
          title={cliUpdating ? "Updating..." : `Update to ${latestCliVersion}`}
        >
          {cliUpdating ? "Updating..." : `Update to ${latestCliVersion}`}
        </button>
      )}

      <span className="app-header-spacer" />
    </div>
  );
}
