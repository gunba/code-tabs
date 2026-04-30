import { parse, quote } from "shell-quote";
import type { PastSession, Session, SessionConfig } from "../types/session";
import { DEFAULT_SESSION_CONFIG } from "../types/session";
import { dirToTabName, parseWorktreePath } from "./paths";
import {
  canResumeSession,
  getLaunchWorkingDir,
  resolveResumeId,
} from "./claudeResume";

export function getForkSourceId(
  session: Session,
  pastSessions: PastSession[] = [],
): string | null {
  if (session.config.sessionId?.trim()) return session.config.sessionId;
  if (session.config.resumeSession?.trim()) return session.config.resumeSession;
  return resolveResumeId(session, pastSessions) ?? (canResumeSession(session) ? session.id : null);
}

export function buildForkSessionName(baseName: string | null | undefined, workingDir: string): string {
  const base = baseName?.trim() || dirToTabName(workingDir) || "Session";
  return `${base} Fork`;
}

export function normalizeForkExtraFlags(flags: string | null | undefined): string | null {
  if (!flags) return null;

  const parsed = parse(flags);
  const tokens: string[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const token = parsed[i];
    if (typeof token !== "string") return flags.trim() || null;

    if (token === "-w" || token === "--worktree") {
      tokens.push("--worktree");
      const next = parsed[i + 1];
      if (typeof next === "string" && next && !next.startsWith("-")) i++;
      continue;
    }
    if (token.startsWith("--worktree=")) {
      tokens.push("--worktree");
      continue;
    }

    tokens.push(token);
  }

  return tokens.length > 0 ? quote(tokens) : null;
}

function getForkWorkingDir(session: Session): string {
  const launchWorkingDir = getLaunchWorkingDir(session);
  return parseWorktreePath(launchWorkingDir)?.projectRoot
    ?? parseWorktreePath(session.config.workingDir)?.projectRoot
    ?? launchWorkingDir;
}

// [RS-09] Fork launch config preserves source id, clears new-process identity,
// and normalizes worktree flags so forks get a generated worktree name.
export function buildForkSessionConfig(
  session: Session,
  pastSessions: PastSession[] = [],
): SessionConfig | null {
  if (!canResumeSession(session)) return null;

  const sourceId = getForkSourceId(session, pastSessions);
  if (!sourceId) return null;

  const launchWorkingDir = getForkWorkingDir(session);
  return {
    ...session.config,
    workingDir: launchWorkingDir,
    launchWorkingDir,
    resumeSession: sourceId,
    forkSession: true,
    continueSession: false,
    extraFlags: normalizeForkExtraFlags(session.config.extraFlags),
    sessionId: null,
    runMode: false,
  };
}

export function buildForkConfigFromPastSession(
  pastSession: PastSession,
  baseConfig: Partial<SessionConfig> | null | undefined,
): SessionConfig {
  const workingDir = parseWorktreePath(pastSession.directory)?.projectRoot ?? (pastSession.directory || ".");
  const merged: SessionConfig = {
    ...DEFAULT_SESSION_CONFIG,
    ...baseConfig,
    cli: pastSession.cli ?? baseConfig?.cli ?? DEFAULT_SESSION_CONFIG.cli,
    workingDir,
    launchWorkingDir: workingDir,
    resumeSession: pastSession.id,
    forkSession: true,
    continueSession: false,
    extraFlags: normalizeForkExtraFlags(baseConfig?.extraFlags),
    sessionId: null,
    runMode: false,
  };
  return merged;
}
