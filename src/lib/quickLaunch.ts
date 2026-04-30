import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import type { Session, SessionConfig } from "../types/session";
import { dirToTabName } from "./claude";

type CreateSession = (name: string, config: SessionConfig) => Promise<Session>;

export async function quickLaunchSession({
  createSession,
  openLauncher,
}: {
  createSession: CreateSession;
  openLauncher: () => void;
}): Promise<void> {
  const { savedDefaults, lastConfig } = useSettingsStore.getState();
  const defaults = savedDefaults && savedDefaults.workingDir.trim() ? savedDefaults : lastConfig;
  if (!defaults || !defaults.workingDir.trim()) {
    openLauncher();
    return;
  }

  // [RS-04] One-shot launch fields never persist into quick-launch defaults.
  const cleanConfig: SessionConfig = {
    ...defaults,
    resumeSession: null,
    forkSession: false,
    continueSession: false,
    sessionId: null,
    runMode: false,
  };
  const { claudePath, codexPath } = useSessionStore.getState();
  const installedCli = [
    ...(claudePath ? ["claude" as const] : []),
    ...(codexPath ? ["codex" as const] : []),
  ];
  if (installedCli.length === 0) {
    openLauncher();
    return;
  }
  if (!installedCli.includes(cleanConfig.cli)) {
    cleanConfig.cli = installedCli[0];
  }

  const settings = useSettingsStore.getState();
  settings.addRecentDir(cleanConfig.workingDir);
  settings.setLastConfig(cleanConfig);
  try {
    await createSession(dirToTabName(cleanConfig.workingDir), cleanConfig);
  } catch {
    openLauncher();
  }
}
