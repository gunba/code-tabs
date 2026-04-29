import { invoke } from "@tauri-apps/api/core";
import type { PastSession, Session, SessionConfig, SessionState, Subagent } from "../types/session";
import { isSessionIdle, isSubagentActive } from "../types/session";
import { canonicalizePath } from "./paths";

export async function buildClaudeArgs(
  config: SessionConfig
): Promise<string[]> {
  return invoke<string[]>("build_claude_args", { config });
}

/** [RS-02] Resume target: chains through revivals to find the original CLI session ID. */
export function getResumeId(session: Session): string {
  return session.config.resumeSession || session.config.sessionId || session.id;
}

/**
 * [RS-08] Auto-resolve a Claude resume id from on-disk JSONLs.
 *
 * Long-lived sessions sometimes report a sessionId via TAP that doesn't
 * match the JSONL filename Claude actually wrote, or a session crashed
 * before TAP captured anything. In that case `getResumeId` falls back
 * to the Code Tabs app id, which is never a valid CLI session id.
 */
export function resolveResumeId(
  session: Session,
  pastSessions: PastSession[]
): string | null {
  const cwd = canonicalizePath(session.config.workingDir).toLowerCase();
  if (!cwd) return null;

  const candidates = pastSessions.filter(
    (p) => canonicalizePath(p.directory).toLowerCase() === cwd && p.cli !== "codex"
  );
  if (candidates.length === 0) return null;

  const storedId = session.config.resumeSession || session.config.sessionId;
  if (storedId) {
    const exact = candidates.find((p) => p.id === storedId);
    if (exact) return exact.id;
  }

  if (candidates.length === 1) return candidates[0].id;

  const anchor = Date.parse(session.lastActive) || Date.parse(session.createdAt) || 0;
  if (!anchor) return candidates[0].id;

  let best = candidates[0];
  let bestDelta = Math.abs(Date.parse(best.lastModified) - anchor);
  if (!Number.isFinite(bestDelta)) bestDelta = Infinity;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const t = Date.parse(c.lastModified);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - anchor);
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best.id;
}

// [DS-03] canResumeSession: resumable only with actual conversation evidence.
// [RS-03] Check conversation existence via resumeSession || nodeSummary || assistantMessageCount.
export function canResumeSession(session: Session): boolean {
  return !!session.config.resumeSession || !!session.metadata.nodeSummary || session.metadata.assistantMessageCount > 0;
}

export function getLaunchWorkingDir(session: Session): string {
  return session.config.launchWorkingDir || session.config.workingDir;
}

/** Find nearest non-dead tab from a given index. Returns null when no live tabs remain. */
export function findNearestLiveTab(sessions: Session[], fromIndex: number): string | null {
  for (let dist = 0; dist < sessions.length; dist++) {
    const right = fromIndex + dist;
    if (right < sessions.length && sessions[right].state !== "dead") return sessions[right].id;
    const left = fromIndex - dist - 1;
    if (left >= 0 && sessions[left].state !== "dead") return sessions[left].id;
  }
  return null;
}

/** [SR-08] Strip -w/--worktree from extraFlags on resume/respawn to avoid duplicate worktree. */
export function stripWorktreeFlags(flags: string | null): string | null {
  if (!flags) return null;
  const stripped = flags.replace(/\s*--?w(?:orktree)?\b/g, "").trim();
  return stripped || null;
}

/** Effective model: user-configured model, falling back to runtime-detected model. */
export function effectiveModel(session: Session): string | null {
  return session.config.model || session.metadata.runtimeModel || null;
}

/** Display-only: returns "toolUse" when session is idle but subagents are active. Not for PTY input gating. */
export function getEffectiveState(state: SessionState, subagents: Subagent[]): SessionState {
  if (isSessionIdle(state) && subagents.some(s => isSubagentActive(s.state))) return "toolUse";
  return state;
}
