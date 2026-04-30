import { useSettingsStore } from "../store/settings";
import type { Session } from "../types/session";
import { canResumeSession, dirToTabName, getLaunchWorkingDir, getResumeId, resolveResumeId, stripWorktreeFlags } from "./claude";
import { dlog } from "./debugLog";

export async function relaunchDeadSession({
  session,
  sessions,
  createSession,
  closeSession,
  setActiveTab,
}: {
  session: Session;
  sessions: Session[];
  createSession: (name: string, config: Session["config"], opts?: { insertAtIndex?: number }) => Promise<Session>;
  closeSession: (id: string) => Promise<void>;
  setActiveTab: (id: string) => void;
}): Promise<void> {
  if (!canResumeSession(session)) return;

  // [RS-08] Auto-resolve: if the dead tab's stored sessionId lost touch with
  // the actual JSONL on disk, pick the right JSONL by cwd + closest lastActive.
  const pastSessions = useSettingsStore.getState().pastSessions;
  const resolvedId = resolveResumeId(session, pastSessions);
  const resumeId = resolvedId ?? getResumeId(session);
  const launchWorkingDir = getLaunchWorkingDir(session);

  const resumeConfig: Session["config"] = {
    ...session.config,
    workingDir: launchWorkingDir,
    launchWorkingDir,
    resumeSession: resumeId,
    forkSession: false,
    continueSession: false,
    extraFlags: stripWorktreeFlags(session.config.extraFlags),
  };
  const insertAtIndex = sessions.findIndex((s) => s.id === session.id);
  const name = session.name || dirToTabName(launchWorkingDir);

  try {
    await createSession(
      name,
      resumeConfig,
      insertAtIndex >= 0 ? { insertAtIndex } : undefined,
    );
    await closeSession(session.id);
  } catch (err) {
    dlog("session", session.id, `dead tab relaunch failed: ${err}`, "ERR");
    setActiveTab(session.id);
  }
}
