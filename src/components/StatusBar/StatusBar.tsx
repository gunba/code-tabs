import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { effectiveModel, modelLabel, modelColor, formatTokenCount } from "../../lib/claude";
import { parseWorktreePath, worktreeAcronym } from "../../lib/paths";
// [HM-10] All status bar icons are inline SVG components -- no emoji
import {
  IconPencil, IconLightning, IconUnlock, IconClipboard,
  IconClock, IconBudget,
  IconWarning, IconHook, IconCircleFilled, IconCircleOutline,
  IconGitBranch,
} from "../Icons/Icons";
import { useGitStatus } from "../../hooks/useGitStatus";
import type { Session, PermissionMode } from "../../types/session";
import type { GitStatusData } from "../../types/git";
import { isSessionIdle } from "../../types/session";
import { getEffectiveState } from "../../lib/claude";
import { useStabilizedValue } from "../../lib/stabilizer";
import "./StatusBar.css";

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

function formatTimeRemaining(resetsAtSecs: number): string {
  if (resetsAtSecs <= 0) return "";
  const diffMs = resetsAtSecs * 1000 - Date.now();
  if (diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
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

function SessionStatus({
  session,
  gitStatus,
}: {
  session: Session;
  gitStatus: GitStatusData | null;
}) {
  const perm = permissionIcon(session.config.permissionMode);
  const inspectorOff = useSessionStore((s) => s.inspectorOffSessions.has(session.id));
  const tapEnabled = useSettingsStore((s) => s.recordingConfig.taps.enabled);
  const health = useSessionStore((s) => s.processHealth.get(session.id));
  const apiIp = useSettingsStore((s) => s.apiIp);
  const model = effectiveModel(session);
  const wt = parseWorktreePath(session.config.workingDir);
  const effort = session.metadata.effortLevel ?? session.config.effort;

  // Branch stabilization: accept first value immediately, then debounce
  // subsequent changes (requires 2+ consecutive matching polls).
  const stableBranch = useStabilizedValue(gitStatus?.branch ?? null, 2);

  // Resolve 5h/7d data: prefer API response headers, fall back to statusLine
  const m = session.metadata;
  const sl = m.statusLine;
  const fiveHour = m.fiveHourPercent ?? sl?.fiveHourUsedPercent ?? null;
  const sevenDay = m.sevenDayPercent ?? sl?.sevenDayUsedPercent ?? null;
  const fiveHourReset = m.fiveHourResetsAt ?? sl?.fiveHourResetsAt ?? 0;
  const sevenDayReset = m.sevenDayResetsAt ?? sl?.sevenDayResetsAt ?? 0;

  return (
    <>
      {/* LEFT: primary operational info */}
      <div className="status-bar-content">
        <span className="status-item status-model" title={
          (m.apiRegion || m.pingRttMs > 0)
            ? `Cloudflare POP: ${m.apiRegion || "—"}` +
              (apiIp ? ` · IP: ${apiIp}` : "") +
              (m.pingRttMs > 0 ? ` · RTT: ${Math.round(m.pingRttMs)}ms` : "") +
              (m.serverTimeMs > 0 ? ` · Server: ${Math.round(m.serverTimeMs)}ms` : "")
            : "Model"
        } style={{ color: modelColor(model) }}>
          {modelLabel(model)}
        </span>
        {effort && (
          <span className="status-item" style={{ opacity: 0.6 }}>
            {effort.charAt(0).toUpperCase() + effort.slice(1)}
          </span>
        )}
        {perm && (
          <span className="status-item status-perm" title={perm.tip}>
            {perm.icon}
          </span>
        )}
        {apiIp && (
          <span className="status-item" style={{ opacity: 0.5 }}>
            {apiIp}
          </span>
        )}
        {m.pingRttMs > 0 && (
          <span className="status-item" title="Network round-trip time (EMA)" style={{ opacity: 0.5 }}>
            {Math.round(m.pingRttMs)}ms
          </span>
        )}
        {m.serverTimeMs > 0 && (
          <span className="status-item" title="Server processing time (EMA)" style={{ opacity: 0.5 }}>
            srv:{Math.round(m.serverTimeMs)}ms
          </span>
        )}
        {(() => {
          const dbg = session.metadata.contextDebug;
          if (!dbg) return null;
          const titleParts = [
            `[${dbg.source}]`,
            `model=${dbg.model ?? "unknown"}`,
            `input+cacheWrite=${(dbg.inputTokens + dbg.cacheCreation).toLocaleString()}`,
            `cacheRead=${dbg.cacheRead.toLocaleString()}`,
            `total=${dbg.totalContextTokens.toLocaleString()}`,
          ];
          const inputCost = dbg.inputTokens + dbg.cacheCreation;
          const label = `${formatTokenCount(inputCost)}${dbg.cacheRead > 0 ? ` (${formatTokenCount(dbg.cacheRead)})` : ""}`;
          return (
            <span
              className="status-item"
              title={titleParts.join("\n")}
              style={{ color: "var(--text-secondary)" }}
            >
              {label}
            </span>
          );
        })()}
        {fiveHour != null && fiveHour > 0 && (() => {
          const rem = formatTimeRemaining(fiveHourReset);
          return (
            <span
              className="status-item"
              title={`5-hour budget: ${Math.round(fiveHour)}% used${rem ? ` · resets in ${rem}` : ""}`}
              style={{ color: fiveHour > 80 ? "var(--error)" : "var(--text-muted)" }}
            >
              5h: {Math.round(fiveHour)}%{rem ? ` (${rem})` : ""}
            </span>
          );
        })()}
        {sevenDay != null && sevenDay > 0 && (() => {
          const rem = formatTimeRemaining(sevenDayReset);
          return (
            <span
              className="status-item"
              title={`7-day budget: ${Math.round(sevenDay)}% used${rem ? ` · resets in ${rem}` : ""}`}
              style={{ color: sevenDay > 80 ? "var(--error)" : "var(--text-muted)" }}
            >
              7d: {Math.round(sevenDay)}%{rem ? ` (${rem})` : ""}
            </span>
          );
        })()}
        {inspectorOff && (
          <span className="status-item status-inspector-off" title="Inspector disconnected — right-click tab to reconnect">
            <IconCircleOutline size={12} /> Inspector off
          </span>
        )}
        {tapEnabled && (
          <span className="status-item" title="Tap recording active — right-click tab to stop" style={{ color: "var(--accent)" }}>
            <IconCircleFilled size={10} /> TAP
          </span>
        )}
      </div>

      {/* RIGHT: secondary info */}
      <div className="status-right">
        <span className="status-item status-duration" title={
          `Duration: ${formatDuration(session.metadata.durationSecs)}` +
          (health ? `\nMemory: ${Math.round(health.rss / 1_000_000)}MB · Heap: ${Math.round(health.heapUsed / 1_000_000)}MB · Uptime: ${formatDuration(Math.floor(health.uptime))}` : "")
        }>
          <span className="status-icon"><IconClock size={12} /></span>
          {formatDuration(session.metadata.durationSecs)}
        </span>
        {wt && (
          <span className="status-item status-worktree" title={wt.worktreeName} style={{ color: "var(--accent-secondary)" }}>
            {worktreeAcronym(wt.worktreeName)}
          </span>
        )}
        {stableBranch && (
          <span className="status-item status-branch" title={`Branch: ${stableBranch}`}>
            <IconGitBranch size={12} /> {stableBranch}
          </span>
        )}
        {((gitStatus?.totalInsertions ?? 0) > 0 || (gitStatus?.totalDeletions ?? 0) > 0) && (
          <span className="status-item status-lines" title="Git changes (staged + unstaged)">
            <span style={{ color: "var(--success)" }}>+{gitStatus!.totalInsertions}</span>
            <span style={{ color: "var(--error)" }}>-{gitStatus!.totalDeletions}</span>
          </span>
        )}
        {session.metadata.lastToolDurationMs != null && session.state === "toolUse" && (
          <span className="status-item" style={{ color: "var(--text-muted)" }} title={
            `Tool: ${session.metadata.lastToolDurationMs}ms` +
            (session.metadata.lastToolResultSize != null ? ` · ${formatTokenCount(session.metadata.lastToolResultSize)} result` : "") +
            (session.metadata.lastToolError ? ` · Error: ${session.metadata.lastToolError}` : "")
          }>
            {session.metadata.lastToolDurationMs}ms
          </span>
        )}
        {session.metadata.apiRetryCount > 0 && (
          <span className="status-item status-retry" title={
            session.metadata.apiRetryInfo
              ? `API retry: attempt ${session.metadata.apiRetryInfo.attempt}, ${Math.round(session.metadata.apiRetryInfo.delayMs)}ms delay, status ${session.metadata.apiRetryInfo.status}`
              : `${session.metadata.apiRetryCount} API retries`
          }>
            <IconWarning size={10} /> {session.metadata.apiRetryCount}
          </span>
        )}
        {session.metadata.stallCount > 0 && session.state === "thinking" && (
          <span className="status-item status-stall" title={`Stream stalled ${session.metadata.stallCount} times, total ${Math.round(session.metadata.stallDurationMs / 1000)}s`}>
            <span className="status-stall-dot" />
          </span>
        )}
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
        {(() => {
          // [SI-25] Prefer cumulative totals from the Status hook snapshot;
          // fall back to ApiTelemetry aggregates when unavailable.
          const totalIn = session.metadata.statusLine?.totalInputTokens ?? session.metadata.inputTokens;
          const totalOut = session.metadata.statusLine?.totalOutputTokens ?? session.metadata.outputTokens;
          const total = totalIn + totalOut;
          if (total <= 0) return null;
          return (
            <span className="status-item" title={`Session total: ${totalIn.toLocaleString()} in + ${totalOut.toLocaleString()} out`}>
              {formatTokenCount(total)}
            </span>
          );
        })()}
        {session.metadata.hookStatus && (
          <span className="status-item status-dynamic" title="Hook executing">
            {session.metadata.hookStatus}
          </span>
        )}
        {!session.metadata.hookStatus && session.metadata.activeSubprocess && (
          <span className="status-item status-dynamic" title="Subprocess running" style={{ opacity: 0.6 }}>
            {session.metadata.activeSubprocess}
          </span>
        )}
      </div>
    </>
  );
}

// [HM-07] Hook count reflects actual entries (sums hooks[] within each MatcherGroup)
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

interface StatusBarProps {
  onOpenContextViewer?: () => void;
}

export function StatusBar({ onOpenContextViewer }: StatusBarProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const [hookCount, setHookCount] = useState(0);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);
  const sidePanel = useSettingsStore((s) => s.sidePanel);
  const setSidePanel = useSettingsStore((s) => s.setSidePanel);

  const { isGitRepo, status: gitStatus } = useGitStatus(activeSession?.config.workingDir ?? null, true);
  const hasChanges = gitStatus != null &&
    (gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length) > 0;

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

  const subagentMap = useSessionStore((s) => s.subagents);
  const aliveSessions = sessions.filter((s) => s.state !== "dead");
  const aliveCountRef = useRef(0);
  aliveCountRef.current = aliveSessions.length;
  // Usage data and ping latency are now derived passively from TAP events
  // (StatusLineUpdate provides 5h/7d percentages, ApiFetch provides latency)
  // instead of polling disabled OAuth endpoints.

  const activeSessions = aliveSessions.filter((s) =>
    !isSessionIdle(getEffectiveState(s.state, subagentMap.get(s.id) || []))
  ).length;
  const allSessionsTokens = useMemo(() => {
    // [SI-25] Cross-session token rollup uses the same statusLine-first fallback.
    return aliveSessions
      .filter((s) => !s.isMetaAgent)
      .reduce((sum, s) => {
        const inT = s.metadata.statusLine?.totalInputTokens ?? s.metadata.inputTokens;
        const outT = s.metadata.statusLine?.totalOutputTokens ?? s.metadata.outputTokens;
        return sum + inT + outT;
      }, 0);
  }, [aliveSessions]);
  return (
    <div className="status-bar">
      {activeSession ? (
        <SessionStatus session={activeSession} gitStatus={gitStatus} />
      ) : (
        <span className="status-empty">No active session</span>
      )}
      {/* Far-right action buttons — always visible */}
      <div className="status-actions">
        {isGitRepo && hasChanges && (
          <button
            className={`status-item status-hooks-btn${sidePanel === "diff" ? " status-active-btn" : ""}`}
            onClick={() => setSidePanel(sidePanel === "diff" ? null : "diff")}
            title="Git changes (Ctrl+Shift+G)"
          >
            <IconGitBranch size={12} /> Changes
          </button>
        )}
        {activeSession?.metadata.capturedSystemPrompt && onOpenContextViewer && (
          <button
            className="status-item status-hooks-btn"
            onClick={onOpenContextViewer}
            title="View system prompt context"
          >
            Context
          </button>
        )}
        <button
          className={`status-item status-hooks-btn${sidePanel === "debug" ? " status-active-btn" : ""}`}
          onClick={() => setSidePanel(sidePanel === "debug" ? null : "debug")}
          title="Debug panel (Ctrl+Shift+D)"
        >
          Debug
        </button>
        <button // [CM-17] Hooks button opens config manager directly to Hooks tab
          className="status-item status-hooks status-hooks-btn"
          onClick={() => setShowConfigManager("hooks")}
          title={hookCount > 0 ? `${hookCount} hooks active — click to manage` : "Hooks — click to manage"}
        >
          <IconHook size={12} /> {hookCount > 0 ? hookCount : "Hooks"}
        </button>
        {allSessionsTokens > 0 && (
          <span className="status-item" title={`Total tokens across all sessions: ${allSessionsTokens.toLocaleString()}`}>
            All: {formatTokenCount(allSessionsTokens)}
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
