import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { useSessionStore } from "../../store/sessions";
import { tapEventBus } from "../../lib/tapEventBus";
import { contextMeterAccumulators } from "../../lib/contextMeterAccumulator";
import { formatTokenCount, modelLabel, modelColor } from "../../lib/claude";
import { normalizePath } from "../../lib/paths";
import type { ContextMeterData, FileMetrics, ModelTokenBreakdown, ToolBreakdown, CacheSnapshot } from "../../types/contextMeter";
import type { Subagent } from "../../types/session";
import "./ContextMeter.css";

export type ContextMeterTarget = { type: "session"; sessionId: string } | { type: "all" };

interface ContextMeterProps {
  target: ContextMeterTarget;
  onClose: () => void;
  onSwitchTarget: (target: ContextMeterTarget) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function abbreviatePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 3) return parts.join("/");
  return parts.slice(-3).join("/");
}

/** Build a snapshot for a single session. */
function getSessionSnapshot(sessionId: string): ContextMeterData | null {
  const acc = contextMeterAccumulators.get(sessionId);
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
  if (!acc || !session) return null;
  return acc.snapshot(sessionId, session.name, session.metadata);
}

/** Merge multiple session snapshots into an aggregate view. */
function mergeSnapshots(snapshots: ContextMeterData[]): ContextMeterData {
  const merged: ContextMeterData = {
    sessionId: "all",
    sessionName: "All Sessions",
    contextPercent: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    totalCachedInputTokens: 0,
    totalUncachedInputTokens: 0,
    cacheHitRate: 0,
    lastCacheRead: 0,
    lastCacheCreation: 0,
    cacheHistory: [],
    modelBreakdowns: [],
    toolBreakdowns: [],
    hotFiles: [],
    recentToolCalls: [],
  };

  const modelMap = new Map<string, ModelTokenBreakdown>();
  const toolMap = new Map<string, ToolBreakdown>();
  const fileMap = new Map<string, FileMetrics>();

  for (const snap of snapshots) {
    merged.totalInputTokens += snap.totalInputTokens;
    merged.totalOutputTokens += snap.totalOutputTokens;
    merged.totalCostUsd += snap.totalCostUsd;
    merged.totalCachedInputTokens += snap.totalCachedInputTokens;
    merged.totalUncachedInputTokens += snap.totalUncachedInputTokens;

    for (const mb of snap.modelBreakdowns) {
      const existing = modelMap.get(mb.model);
      if (existing) {
        existing.inputTokens += mb.inputTokens;
        existing.outputTokens += mb.outputTokens;
        existing.cachedInputTokens += mb.cachedInputTokens;
        existing.uncachedInputTokens += mb.uncachedInputTokens;
        existing.costUsd += mb.costUsd;
        existing.callCount += mb.callCount;
      } else {
        modelMap.set(mb.model, { ...mb });
      }
    }

    for (const tb of snap.toolBreakdowns) {
      const existing = toolMap.get(tb.toolName);
      if (existing) {
        existing.callCount += tb.callCount;
        existing.totalResultBytes += tb.totalResultBytes;
        existing.totalDurationMs += tb.totalDurationMs;
        existing.errorCount += tb.errorCount;
      } else {
        toolMap.set(tb.toolName, { ...tb });
      }
    }

    for (const hf of snap.hotFiles) {
      const key = normalizePath(hf.filePath);
      const existing = fileMap.get(key);
      if (existing) {
        existing.readCount += hf.readCount;
        existing.writeCount += hf.writeCount;
        existing.editCount += hf.editCount;
        existing.cumulativeResultBytes += hf.cumulativeResultBytes;
        existing.lastAccessTs = Math.max(existing.lastAccessTs, hf.lastAccessTs);
      } else {
        fileMap.set(key, { ...hf });
      }
    }
  }

  const totalInput = merged.totalCachedInputTokens + merged.totalUncachedInputTokens;
  merged.cacheHitRate = totalInput > 0 ? Math.round((merged.totalCachedInputTokens / totalInput) * 100) : 0;
  // Use max contextPercent across sessions (averaging is semantically wrong)
  merged.contextPercent = snapshots.length > 0 ? Math.max(...snapshots.map((s) => s.contextPercent)) : 0;
  merged.modelBreakdowns = [...modelMap.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  merged.toolBreakdowns = [...toolMap.values()].sort((a, b) => b.totalResultBytes - a.totalResultBytes);
  merged.hotFiles = [...fileMap.values()].sort((a, b) => b.cumulativeResultBytes - a.cumulativeResultBytes);

  return merged;
}

/* ── Panels ───────────────────────────────────────────── */

function ContextCachePanel({ data }: { data: ContextMeterData }) {
  const session = data.sessionId !== "all"
    ? useSessionStore.getState().sessions.find((s) => s.id === data.sessionId)
    : null;
  const budget = session?.metadata?.contextBudget;
  const sysTok = session ? Math.round((session.metadata.systemPromptLength || 0) / 4) : 0;

  return (
    <div className="cm-panel">
      <div className="cm-panel-title">Context & Cache</div>
      <div className="cm-context-pct">{data.contextPercent}%</div>
      <div className="cm-cache-rate" style={{ color: data.cacheHitRate >= 80 ? "var(--success, #4ade80)" : data.cacheHitRate >= 50 ? "var(--text-secondary)" : "var(--error, #ef4444)" }}>
        {data.cacheHitRate}% cached
      </div>
      <div className="cm-cache-bar">
        <div className="cm-cache-bar-fill" style={{ width: `${data.cacheHitRate}%` }} />
      </div>
      <div className="cm-cache-stats">
        <span className="cm-cache-stat-cached">{formatTokenCount(data.totalCachedInputTokens)} cached</span>
        <span className="cm-cache-stat-uncached">{formatTokenCount(data.totalUncachedInputTokens)} uncached</span>
      </div>

      {budget && (
        <>
          <div className="cm-composition-row">
            <span>System prompt</span>
            <span className="cm-comp-value">~{formatTokenCount(sysTok)}</span>
          </div>
          <div className="cm-composition-row">
            <span>CLAUDE.md</span>
            <span className="cm-comp-value">{formatTokenCount(budget.claudeMdSize)}</span>
          </div>
          <div className="cm-composition-row">
            <span>Tool definitions</span>
            <span className="cm-comp-value">{formatTokenCount(budget.mcpToolsTokens + budget.nonMcpToolsTokens)}</span>
          </div>
          <div className="cm-composition-row">
            <span>Conversation</span>
            <span className="cm-comp-value">{formatTokenCount(Math.max(0, budget.totalContextSize - budget.mcpToolsTokens - budget.nonMcpToolsTokens - sysTok - budget.claudeMdSize))}</span>
          </div>
        </>
      )}

      {data.cacheHistory.length > 1 && (
        <>
          <div className="cm-panel-title" style={{ marginTop: 14 }}>Cache Trend</div>
          <CacheSparkline history={data.cacheHistory} />
        </>
      )}
    </div>
  );
}

function CacheSparkline({ history }: { history: CacheSnapshot[] }) {
  return (
    <div className="cm-sparkline">
      {history.map((snap, i) => {
        const total = snap.cachedInputTokens + snap.uncachedInputTokens;
        const rate = total > 0 ? snap.cachedInputTokens / total : 0;
        const height = Math.max(2, Math.round(rate * 28));
        const green = Math.round(rate * 200 + 55);
        const red = Math.round((1 - rate) * 200 + 55);
        return (
          <div
            key={i}
            className="cm-spark-bar"
            style={{
              height: `${height}px`,
              background: `rgb(${Math.min(red, 200)}, ${Math.min(green, 220)}, ${Math.min(80 + Math.round(rate * 60), 140)})`,
            }}
            title={`Turn ${snap.turnIndex}: ${Math.round(rate * 100)}% cached`}
          />
        );
      })}
    </div>
  );
}

function TokenBreakdownPanel({ data }: { data: ContextMeterData }) {
  const maxModelTokens = data.modelBreakdowns.length > 0
    ? Math.max(...data.modelBreakdowns.map((m) => m.inputTokens + m.outputTokens))
    : 1;

  return (
    <div className="cm-panel">
      <div className="cm-panel-title">Token Breakdown</div>

      {data.modelBreakdowns.length === 0 && <div className="cm-empty">No API calls yet</div>}

      {data.modelBreakdowns.map((mb) => {
        const total = mb.inputTokens + mb.outputTokens;
        const pct = total / maxModelTokens;
        const cachedPct = total > 0 ? (mb.cachedInputTokens / total) * pct * 100 : 0;
        const uncachedPct = total > 0 ? (mb.uncachedInputTokens / total) * pct * 100 : 0;
        const outputPct = total > 0 ? (mb.outputTokens / total) * pct * 100 : 0;
        const color = modelColor(mb.model);

        return (
          <div key={mb.model}>
            <div className="cm-model-row">
              <div className="cm-model-dot" style={{ background: color }} />
              <span className="cm-model-label">{mb.label}</span>
              <div className="cm-model-bar-container">
                <div className="cm-model-bar-cached" style={{ width: `${cachedPct}%`, background: color }} />
                <div className="cm-model-bar-uncached" style={{ width: `${uncachedPct}%`, background: color }} />
                <div className="cm-model-bar-output" style={{ width: `${outputPct}%`, background: color }} />
              </div>
            </div>
            <div className="cm-model-detail">
              {formatTokenCount(mb.cachedInputTokens)} cached · {formatTokenCount(mb.uncachedInputTokens)} uncached · {formatTokenCount(mb.outputTokens)} out · ${mb.costUsd.toFixed(4)} · {mb.callCount} calls
            </div>
          </div>
        );
      })}

      {data.toolBreakdowns.length > 0 && (
        <>
          <div className="cm-panel-title" style={{ marginTop: 14 }}>By Tool</div>
          <table className="cm-tool-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Calls</th>
                <th>Result</th>
                <th>Time</th>
                <th>Err</th>
              </tr>
            </thead>
            <tbody>
              {data.toolBreakdowns.map((tb) => (
                <tr key={tb.toolName}>
                  <td>{tb.toolName}</td>
                  <td>{tb.callCount}</td>
                  <td>{formatBytes(tb.totalResultBytes)}</td>
                  <td>{tb.totalDurationMs < 1000 ? `${tb.totalDurationMs}ms` : `${(tb.totalDurationMs / 1000).toFixed(1)}s`}</td>
                  <td>{tb.errorCount > 0 ? tb.errorCount : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function HotFilesPanel({ data }: { data: ContextMeterData }) {
  const maxBytes = data.hotFiles.length > 0 ? data.hotFiles[0].cumulativeResultBytes : 1;

  return (
    <div className="cm-panel">
      <div className="cm-panel-title">Hot Files</div>

      {data.hotFiles.length === 0 && <div className="cm-empty">No file operations yet</div>}

      {data.hotFiles.slice(0, 50).map((hf) => {
        const pct = maxBytes > 0 ? (hf.cumulativeResultBytes / maxBytes) * 100 : 0;
        const totalOps = hf.readCount + hf.writeCount + hf.editCount;
        return (
          <div key={hf.filePath} className="cm-hot-file" title={hf.filePath}>
            <div className="cm-hot-file-header">
              <span className="cm-hot-file-path">{abbreviatePath(hf.filePath)}</span>
              <span className="cm-hot-file-count">{totalOps}x</span>
              <span className="cm-hot-file-bytes">{formatBytes(hf.cumulativeResultBytes)}</span>
            </div>
            <div className="cm-hot-file-bar">
              <div className="cm-hot-file-bar-fill" style={{ width: `${pct}%`, opacity: 0.4 + (pct / 100) * 0.6 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SubagentFooter({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const subagents = useSessionStore((s) => {
    const subs = s.subagents.get(sessionId);
    return subs && subs.length > 0 ? subs : null;
  });

  if (!subagents) return null;

  return (
    <div className="cm-footer">
      <button className="cm-footer-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Subagent Attribution ({subagents.length})
      </button>
      {open && (
        <div className="cm-footer-content">
          {subagents.map((sub: Subagent) => (
            <div key={sub.id} className="cm-subagent-row">
              <span className="cm-subagent-desc">{sub.description}</span>
              {sub.model && <span className="cm-subagent-model" style={{ color: modelColor(sub.model) }}>{modelLabel(sub.model)}</span>}
              <span className="cm-subagent-tokens">{formatTokenCount(sub.tokenCount)}</span>
              {sub.costUsd != null && <span className="cm-subagent-cost">${sub.costUsd.toFixed(4)}</span>}
              {sub.totalToolUses != null && <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{sub.totalToolUses} tools</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── All Sessions Summary ─────────────────────────────── */

function AllSessionsSummary({ snapshots }: { snapshots: ContextMeterData[] }) {
  return (
    <div className="cm-panel" style={{ gridColumn: "1 / -1" }}>
      <div className="cm-panel-title">Per-Session Summary</div>
      {snapshots.map((snap) => (
        <div key={snap.sessionId} className="cm-session-summary">
          <span className="cm-session-name">{snap.sessionName}</span>
          <span className="cm-session-stat">{snap.contextPercent}%</span>
          <span className="cm-session-stat">{formatTokenCount(snap.totalInputTokens + snap.totalOutputTokens)}</span>
          <span className="cm-session-stat">{snap.cacheHitRate}% cached</span>
          <span className="cm-session-stat" style={{ color: "var(--text-muted)" }}>${snap.totalCostUsd.toFixed(4)}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Main Component ───────────────────────────────────── */

export function ContextMeter({ target, onClose, onSwitchTarget }: ContextMeterProps) {
  const [data, setData] = useState<ContextMeterData | null>(null);
  const [sessionSnapshots, setSessionSnapshots] = useState<ContextMeterData[]>([]);
  const sessions = useSessionStore((s) => s.sessions);
  const targetRef = useRef(target);
  targetRef.current = target;

  const refreshData = useCallback(() => {
    const t = targetRef.current;
    if (t.type === "session") {
      const snap = getSessionSnapshot(t.sessionId);
      setData(snap);
    } else {
      const snaps: ContextMeterData[] = [];
      for (const s of useSessionStore.getState().sessions) {
        if (s.state === "dead") continue;
        const snap = getSessionSnapshot(s.id);
        if (snap) snaps.push(snap);
      }
      setSessionSnapshots(snaps);
      setData(mergeSnapshots(snaps));
    }
  }, []);

  // Initial load
  useEffect(() => { refreshData(); }, [refreshData, target]);

  // Push-based refresh: subscribe to tapEventBus for relevant sessions
  // Dedup via requestAnimationFrame to avoid expensive snapshot on every event
  useEffect(() => {
    let rafId = 0;
    const debouncedRefresh = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        refreshData();
      });
    };

    const unsubs: (() => void)[] = [];

    if (target.type === "session") {
      unsubs.push(tapEventBus.subscribe(target.sessionId, debouncedRefresh));
    } else {
      for (const s of sessions) {
        if (s.state !== "dead") {
          unsubs.push(tapEventBus.subscribe(s.id, debouncedRefresh));
        }
      }
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      for (const u of unsubs) u();
    };
  }, [target, sessions, refreshData]);


  return createPortal(
    <div onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }}>
      <ModalOverlay onClose={onClose} className="context-meter-modal">
        {/* Header */}
        <div className="cm-header">
          <span className="cm-title">Context Meter</span>
          <div className="cm-view-toggle">
            {sessions.filter((s) => s.state !== "dead").map((s) => (
              <button
                key={s.id}
                className={`cm-view-btn ${target.type === "session" && target.sessionId === s.id ? "active" : ""}`}
                onClick={() => onSwitchTarget({ type: "session", sessionId: s.id })}
              >
                {s.name}
              </button>
            ))}
            <button
              className={`cm-view-btn ${target.type === "all" ? "active" : ""}`}
              onClick={() => onSwitchTarget({ type: "all" })}
            >
              All Sessions
            </button>
          </div>
          <button className="cm-close" onClick={onClose}>×</button>
        </div>

        {/* Body */}
        {data ? (
          <>
            <div className="cm-body">
              <ContextCachePanel data={data} />
              <TokenBreakdownPanel data={data} />
              <HotFilesPanel data={data} />
            </div>

            {/* Per-session summary in all-sessions mode */}
            {target.type === "all" && sessionSnapshots.length > 0 && (
              <AllSessionsSummary snapshots={sessionSnapshots} />
            )}

            {/* Subagent footer for single-session mode */}
            {target.type === "session" && (
              <SubagentFooter sessionId={target.sessionId} />
            )}
          </>
        ) : (
          <div className="cm-body">
            <div className="cm-panel"><div className="cm-empty">No data available</div></div>
            <div className="cm-panel" />
            <div className="cm-panel" />
          </div>
        )}
      </ModalOverlay>
    </div>,
    document.body,
  );
}
