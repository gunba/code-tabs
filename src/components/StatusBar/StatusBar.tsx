import { useState, useEffect, useRef } from "react";
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
import { dlog } from "../../lib/debugLog";
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

function SessionStatus({ session, gitStatus }: { session: Session; gitStatus: GitStatusData | null }) {
  const perm = permissionIcon(session.config.permissionMode);
  const inspectorOff = useSessionStore((s) => s.inspectorOffSessions.has(session.id));
  const tapEnabled = useSessionStore((s) => (s.tapCategories.get(session.id)?.size ?? 0) > 0);
  const health = useSessionStore((s) => s.processHealth.get(session.id));
  const apiIp = useSettingsStore((s) => s.apiIp);
  const model = effectiveModel(session);
  const wt = parseWorktreePath(session.config.workingDir);
  const effort = session.metadata.effortLevel ?? session.config.effort;

  return (
    <div className="status-bar-content">
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
      <span className="status-item status-model" title={
        (session.metadata.apiRegion || session.metadata.apiLatencyMs > 0)
          ? `Cloudflare POP: ${session.metadata.apiRegion || "—"}` +
            (apiIp ? ` · IP: ${apiIp}` : "") +
            (session.metadata.apiLatencyMs > 0 ? ` · Latency: ${Math.round(session.metadata.apiLatencyMs)}ms (time to headers)` : "")
          : "Model"
      } style={{ color: modelColor(model) }}>
        {modelLabel(model)}
        {effort && (
          <span style={{ opacity: 0.6 }}>{` · ${effort.charAt(0).toUpperCase() + effort.slice(1)} effort`}</span>
        )}
        {session.metadata.subscriptionType && (
          <span style={{ opacity: 0.6 }}>{` · ${session.metadata.subscriptionType.charAt(0).toUpperCase() + session.metadata.subscriptionType.slice(1)}`}</span>
        )}
        {session.metadata.apiRegion && (
          <span style={{ opacity: 0.6 }}>{` · ${session.metadata.apiRegion}`}</span>
        )}
        {apiIp && session.metadata.apiRegion && (
          <span style={{ opacity: 0.5 }}>{` (${apiIp})`}</span>
        )}
        {session.metadata.apiLatencyMs > 0 && (
          <span style={{ opacity: 0.6 }}>{` · ${Math.round(session.metadata.apiLatencyMs)}ms`}</span>
        )}
      </span>
      {wt && (
        <span className="status-item status-worktree" title={wt.worktreeName} style={{ color: "var(--accent-secondary)" }}>
          {worktreeAcronym(wt.worktreeName)}
        </span>
      )}
      {gitStatus?.branch && (
        <span className="status-item status-branch" title={`Branch: ${gitStatus.branch}`}>
          <IconGitBranch size={12} /> {gitStatus.branch}
        </span>
      )}
      {((gitStatus?.totalInsertions ?? 0) > 0 || (gitStatus?.totalDeletions ?? 0) > 0) && (
        <span className="status-item status-lines" title="Git changes (staged + unstaged)">
          <span style={{ color: "var(--success)" }}>+{gitStatus!.totalInsertions}</span>
          <span style={{ color: "var(--error)" }}>-{gitStatus!.totalDeletions}</span>
        </span>
      )}
      {perm && (
        <span className="status-item status-perm" title={perm.tip}>
          {perm.icon}
        </span>
      )}
      <span className="status-item status-duration" title={
        `Duration: ${formatDuration(session.metadata.durationSecs)}` +
        (health ? `\nMemory: ${Math.round(health.rss / 1_000_000)}MB · Heap: ${Math.round(health.heapUsed / 1_000_000)}MB · Uptime: ${formatDuration(Math.floor(health.uptime))}` : "")
      }>
        <span className="status-icon"><IconClock size={12} /></span>
        {formatDuration(session.metadata.durationSecs)}
      </span>
      {session.metadata.lastToolDurationMs != null && session.state === "toolUse" && (
        <span className="status-item" style={{ color: "var(--text-muted)", fontSize: "0.85em" }} title={
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
        const ctxPct = session.metadata.contextPercent ?? 0;
        const dbg = session.metadata.contextDebug;
        if (ctxPct <= 0 && !dbg) return null;
        const titleParts = [`Context: ${ctxPct}%`];
        if (dbg) {
          titleParts.push(`[${dbg.source}]`);
          titleParts.push(`model=${dbg.model ?? "unknown"}`);
          titleParts.push(`input=${dbg.inputTokens.toLocaleString()}`);
          titleParts.push(`cacheRead=${dbg.cacheRead.toLocaleString()}`);
          titleParts.push(`cacheCreation=${dbg.cacheCreation.toLocaleString()}`);
          titleParts.push(`total=${dbg.totalContextTokens.toLocaleString()} / ${dbg.windowSize.toLocaleString()}`);
          titleParts.push(`windowSource=${dbg.windowSource}`);
        }
        return (
          <span
            className="status-item"
            title={titleParts.join("\n")}
            style={{ color: ctxPct > 80 ? "var(--error)" : ctxPct > 50 ? "var(--warning)" : "var(--text-secondary)" }}
          >
            {ctxPct}% ctx
          </span>
        );
      })()}
      {((session.metadata.statusLine?.currentInputTokens ?? 0) + (session.metadata.statusLine?.currentOutputTokens ?? 0)) > 0 && (
        <span className="status-item" title="Session tokens (input + output)">
          {formatTokenCount((session.metadata.statusLine!.currentInputTokens ?? 0) + (session.metadata.statusLine!.currentOutputTokens ?? 0))}
        </span>
      )}
      {(session.metadata.statusLine?.fiveHourUsedPercent ?? 0) > 0 && (
        <span
          className="status-item"
          title={`5-hour budget: ${session.metadata.statusLine!.fiveHourUsedPercent}% used`}
          style={{ color: session.metadata.statusLine!.fiveHourUsedPercent > 80 ? "var(--error)" : "var(--text-muted)" }}
        >
          5h: {Math.round(session.metadata.statusLine!.fiveHourUsedPercent)}%
        </span>
      )}
      {(session.metadata.statusLine?.sevenDayUsedPercent ?? 0) > 0 && (
        <span
          className="status-item"
          title={`7-day budget: ${session.metadata.statusLine!.sevenDayUsedPercent}% used`}
          style={{ color: session.metadata.statusLine!.sevenDayUsedPercent > 80 ? "var(--error)" : "var(--text-muted)" }}
        >
          7d: {Math.round(session.metadata.statusLine!.sevenDayUsedPercent)}%
        </span>
      )}
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

export function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const [hookCount, setHookCount] = useState(0);
  const [usageData, setUsageData] = useState<{ fiveHourPercent: number | null; sevenDayPercent: number | null } | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
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
  // Poll Anthropic Usage API for 5h/7d rate-limit utilization.
  // Timer-based poll is justified: there is no push source for this data.
  // Ref check avoids re-triggering the effect (and an immediate poll) on every session change.
  useEffect(() => {
    const poll = () => {
      if (aliveCountRef.current === 0) return;
      invoke<{ fiveHourPercent: number | null; sevenDayPercent: number | null }>("fetch_usage")
        .then((d) => { setUsageData(d); setUsageError(null); })
        .catch((e: unknown) => {
          const msg = String(e);
          dlog("session", null, `fetch_usage failed: ${msg}`, "WARN");
          setUsageError(msg);
        });
    };
    poll();
    const t = setInterval(poll, 120_000);
    return () => clearInterval(t);
  }, []);

  const activeSessions = aliveSessions.filter((s) =>
    !isSessionIdle(getEffectiveState(s.state, subagentMap.get(s.id) || []))
  ).length;
  return (
    <div className="status-bar">
      {activeSession ? (
        <SessionStatus session={activeSession} gitStatus={gitStatus} />
      ) : (
        <span className="status-empty">No active session</span>
      )}
      <div className="status-right">
        {activeSession?.metadata.statusLine == null && usageError && (
          <span className="status-item" title={`Usage fetch failed: ${usageError}`} style={{ color: "var(--text-muted)" }}>
            5h/7d: ?
          </span>
        )}
        {activeSession?.metadata.statusLine == null && !usageError && usageData?.fiveHourPercent != null && (
          <span
            className="status-item"
            title="5-hour rate limit usage"
            style={{ color: usageData.fiveHourPercent > 80 ? "var(--error)" : "var(--text-muted)" }}
          >
            5h: {Math.round(usageData.fiveHourPercent)}%
          </span>
        )}
        {activeSession?.metadata.statusLine == null && !usageError && usageData?.sevenDayPercent != null && (
          <span
            className="status-item"
            title="7-day rate limit usage"
            style={{ color: usageData.sevenDayPercent > 80 ? "var(--error)" : "var(--text-muted)" }}
          >
            7d: {Math.round(usageData.sevenDayPercent)}%
          </span>
        )}
        {isGitRepo && hasChanges && (
          <button
            className={`status-item status-hooks-btn${sidePanel === "diff" ? " status-active-btn" : ""}`}
            onClick={() => setSidePanel(sidePanel === "diff" ? null : "diff")}
            title="Git changes (Ctrl+Shift+G)"
          >
            <IconGitBranch size={12} /> Changes
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
