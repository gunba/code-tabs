import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { effectiveModel, modelLabel, modelColor, formatTokenCount } from "../../lib/claude";
import { parseWorktreePath, worktreeAcronym } from "../../lib/paths";
import {
  IconPencil, IconLightning, IconUnlock, IconClipboard,
  IconHalfCircle, IconDiamond, IconClock, IconBudget,
  IconWarning, IconHook, IconCircleFilled, IconCircleOutline,
} from "../Icons/Icons";
import type { Session, PermissionMode } from "../../types/session";
import "./StatusBar.css";

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

function permissionIcon(mode: PermissionMode): { icon: React.ReactNode; tip: string } | null {
  switch (mode) {
    case "acceptEdits":
      return { icon: <IconPencil size={12} />, tip: "Accept Edits" };
    case "bypassPermissions":
      return { icon: <IconLightning size={12} />, tip: "Bypass Permissions" };
    case "dontAsk":
      return { icon: <IconUnlock size={12} />, tip: "Don't Ask" };
    case "planMode":
      return { icon: <IconClipboard size={12} />, tip: "Plan Mode" };
    default:
      return null;
  }
}

function SessionStatus({ session }: { session: Session }) {
  const perm = permissionIcon(session.config.permissionMode);
  const inspectorOff = useSessionStore((s) => s.inspectorOffSessions.has(session.id));
  const model = effectiveModel(session);
  const wt = parseWorktreePath(session.config.workingDir);

  return (
    <div className="status-bar-content">
      {inspectorOff && (
        <span className="status-item status-inspector-off" title="Inspector disconnected — right-click tab to reconnect">
          <IconCircleOutline size={12} /> Inspector off
        </span>
      )}
      <span className="status-item status-model" title="Model" style={{ color: modelColor(model) }}>
        {modelLabel(model)}
      </span>
      {wt && (
        <span className="status-item status-worktree" title={wt.worktreeName} style={{ color: "var(--accent-secondary)" }}>
          {worktreeAcronym(wt.worktreeName)}
        </span>
      )}
      {perm && (
        <span className="status-item status-perm" title={perm.tip}>
          {perm.icon}
        </span>
      )}
      <span className="status-item status-context" title="Context usage">
        <span className="status-icon"><IconHalfCircle size={12} /></span>
        {session.metadata.contextPercent > 0
          ? `${session.metadata.contextPercent.toFixed(0)}%`
          : "—"}
      </span>
      <span className="status-item status-cost" title={`This session — Input: ${formatTokenCount(session.metadata.inputTokens)}, Output: ${formatTokenCount(session.metadata.outputTokens)}`}>
        <span className="status-icon"><IconDiamond size={12} /></span>
        {formatTokenCount(session.metadata.inputTokens + session.metadata.outputTokens)} tokens
      </span>
      <span className="status-item status-duration" title="Session uptime (since creation)">
        <span className="status-icon"><IconClock size={12} /></span>
        {formatDuration(session.metadata.durationSecs)}
      </span>
      {session.config.maxBudget && (
        <span className="status-item status-budget" title={`Budget: $${session.config.maxBudget}`}>
          <span className="status-icon"><IconBudget size={12} /></span>
          ${session.config.maxBudget}
        </span>
      )}
      {session.config.dangerouslySkipPermissions && (
        <span className="status-item status-dangerous" title="Dangerous mode — all permissions skipped">
          <IconWarning size={12} />
        </span>
      )}
    </div>
  );
}

function countHookEntries(hooks: Record<string, unknown>): number {
  let count = 0;
  for (const scopeHooks of Object.values(hooks)) {
    if (typeof scopeHooks !== "object" || scopeHooks === null) continue;
    for (const matcherGroups of Object.values(scopeHooks as Record<string, unknown>)) {
      if (!Array.isArray(matcherGroups)) continue;
      for (const mg of matcherGroups) {
        count += (mg as { hooks?: unknown[] }).hooks?.length ?? 0;
      }
    }
  }
  return count;
}

export function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const [hookCount, setHookCount] = useState(0);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);

  useEffect(() => {
    const dirs = sessions
      .filter((s) => !s.isMetaAgent && s.state !== "dead")
      .map((s) => s.config.workingDir)
      .filter(Boolean);
    if (dirs.length === 0) {
      setHookCount(0);
      return;
    }
    invoke<Record<string, unknown>>("discover_hooks", { workingDirs: dirs })
      .then((hooks) => {
        setHookCount(countHookEntries(hooks));
      })
      .catch(() => setHookCount(0));
  }, [sessions]);

  const aliveSessions = sessions.filter((s) => s.state !== "dead");
  const activeSessions = aliveSessions.filter((s) => s.state !== "idle").length;
  const totalTokens = aliveSessions.reduce(
    (sum, s) => sum + s.metadata.inputTokens + s.metadata.outputTokens, 0
  );

  return (
    <div className="status-bar">
      {activeSession ? (
        <SessionStatus session={activeSession} />
      ) : (
        <span className="status-empty">No active session</span>
      )}
      <div className="status-right">
        <button
          className="status-item status-hooks status-hooks-btn"
          onClick={() => setShowConfigManager("hooks")}
          title={hookCount > 0 ? `${hookCount} hooks active — click to manage` : "Hooks — click to manage"}
        >
          <IconHook size={12} /> {hookCount > 0 ? hookCount : "Hooks"}
        </button>
        {totalTokens > 0 && aliveSessions.length > 1 && (
          <span className="status-item status-total-tokens" title="Total tokens across all active sessions">
            <span className="status-icon">Σ</span>
            {formatTokenCount(totalTokens)}
          </span>
        )}
        {activeSessions > 0 && (
          <span className="status-item status-active" title={`${activeSessions} active`}>
            <span className="status-active-dot" />
            {activeSessions}
          </span>
        )}
        <span className="status-item" title={`${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}>
          <IconCircleFilled size={12} /> {sessions.length}
        </span>
      </div>
    </div>
  );
}
