import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminal } from "../../hooks/useTerminal";
import { usePty } from "../../hooks/usePty";
import { useSessionStore } from "../../store/sessions";
import { getResumeId } from "../../lib/claude";
import { dlog } from "../../lib/debugLog";
import { useTapPipeline } from "../../hooks/useTapPipeline";
import { useTapEventProcessor } from "../../hooks/useTapEventProcessor";
import { writeToPty } from "../../lib/ptyRegistry";
import { useSettingsStore } from "../../store/settings";
import { useRuntimeStore } from "../../store/runtime";
import { traceAsync } from "../../lib/perfTrace";
import type { Session } from "../../types/session";
import type { TerminalController } from "./terminalPanelTypes";
import { useDurationTimer } from "./useDurationTimer";
import { useSessionDeath } from "./useSessionDeath";
import { useSessionRespawn } from "./useSessionRespawn";
import { useTerminalContainer, useTerminalPanelEffects } from "./useTerminalPanelEffects";
import { useTerminalInspector } from "./useTerminalInspector";
import { useTerminalSetup } from "./useTerminalSetup";
import "./TerminalPanel.css";

const CLAUDE_SCROLLBACK_LINES = 100_000;
const CODEX_SCROLLBACK_LINES = 50_000;

interface TerminalPanelProps {
  session: Session;
  visible: boolean;
}

// [TA-13] React.memo with terminalPanelPropsEqual gates rerenders on the subset of session fields the panel actually depends on; tap-event-driven metadata churn no longer rerenders the heavy terminal subtree.
function terminalPanelPropsEqual(prev: TerminalPanelProps, next: TerminalPanelProps): boolean {
  return prev.visible === next.visible
    && prev.session.id === next.session.id
    && prev.session.state === next.session.state
    && prev.session.name === next.session.name
    && prev.session.config === next.session.config
    && prev.session.metadata.nodeSummary === next.session.metadata.nodeSummary
    && prev.session.metadata.assistantMessageCount === next.session.metadata.assistantMessageCount;
}

// ── Terminal Panel ──────────────────────────────────────────────────────

export const TerminalPanel = memo(function TerminalPanel({ session, visible }: TerminalPanelProps) {
  const claudePath = useSessionStore((s) => s.claudePath);
  const codexPath = useSessionStore((s) => s.codexPath);
  const initialized = useSessionStore((s) => s.initialized);
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const [respawnCounter, setRespawnCounter] = useState(0);
  const terminalRef = useRef<TerminalController | null>(null);
  const retryRespawnRef = useRef<() => void>(() => {});

  const {
    inspector,
    loading,
    setInspectorPort,
    setLoading,
  } = useTerminalInspector(session);

  useTapPipeline({
    sessionId: session.state !== "dead" ? session.id : null,
    wsSend: inspector.wsSend,
    connected: inspector.connected,
  });

  // Auto-start traffic logging when recording config enables it
  const trafficEnabled = useSettingsStore((s) =>
    (s.recordingConfigsByCli[session.config.cli] ?? s.recordingConfig).traffic.enabled
  );
  const observabilityEnabled = useRuntimeStore((s) => s.observabilityInfo.observabilityEnabled);
  const startTrafficLog = useSessionStore((s) => s.startTrafficLog);
  const stopTrafficLog = useSessionStore((s) => s.stopTrafficLog);
  const trafficStartedRef = useRef(false);
  useEffect(() => {
    if (!inspector.connected || session.state === "dead") {
      trafficStartedRef.current = false;
      return;
    }
    if (observabilityEnabled && trafficEnabled && !trafficStartedRef.current) {
      trafficStartedRef.current = true;
      traceAsync("traffic.start_auto_log", () => invoke<string>("start_traffic_log", { sessionId: session.id }), {
        module: "traffic",
        sessionId: session.id,
        event: "traffic.start_auto_log",
        warnAboveMs: 250,
        data: {},
      })
        .then((path) => startTrafficLog(session.id, path))
        .catch((e) => dlog("traffic", session.id, `auto-start failed: ${e}`, "WARN"));
    }
  }, [inspector.connected, observabilityEnabled, trafficEnabled, session.id, session.state, startTrafficLog]);

  // Tap event processor: sole source of state, metadata, subagent data
  const tapProcessor = useTapEventProcessor(
    session.state !== "dead" ? session.id : null
  );

  // Sync Claude's internal session ID into config for persistence (plan-mode forks, compaction)
  const prevClaudeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tapProcessor.claudeSessionId) {
      // Session reset (respawn/restart) - forget the previous ID so JSONL replay
      // session registrations don't trigger a spurious terminal clear.
      prevClaudeSessionIdRef.current = null;
      return;
    }
    prevClaudeSessionIdRef.current = tapProcessor.claudeSessionId;
    if (tapProcessor.claudeSessionId !== session.config.sessionId) {
      updateConfig(session.id, { sessionId: tapProcessor.claudeSessionId });
    }
  }, [tapProcessor.claudeSessionId, session.id, session.config.sessionId, updateConfig]);

  // Duration timer
  useDurationTimer(session.id, session.state, respawnCounter);

  const sessionDeath = useSessionDeath({
    sessionId: session.id,
    resumeId: getResumeId(session),
    terminalRef,
    triggerRespawnRef: retryRespawnRef,
  });

  const pty = usePty({
    sessionId: session.id,
    onData: sessionDeath.handlePtyData,
    onExit: sessionDeath.handlePtyExit,
  });

  const triggerRespawn = useSessionRespawn({
    inspectorDisconnect: inspector.disconnect,
    ptyCleanup: pty.cleanup,
    resetSessionInUseDetection: sessionDeath.resetSessionInUseDetection,
    session,
    setExternalHolder: sessionDeath.setExternalHolder,
    setInspectorPort,
    setLoading,
    setRespawnCounter,
  });

  useLayoutEffect(() => {
    retryRespawnRef.current = () => triggerRespawn();
  }, [triggerRespawn]);

  const handleTermData = useCallback(
    (data: string) => {
      if (session.state === "dead") return; // Resume via tab click, not keyboard
      writeToPty(session.id, data);
    },
    [session.id, session.state]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      pty.handle.current?.resize(cols, rows);
    },
    [pty.handle]
  );

  const terminal = useTerminal({
    sessionId: session.id,
    onData: handleTermData,
    onResize: handleResize,
    instanceKey: respawnCounter,
    cwd: session.config.workingDir ?? null,
    scrollback: session.config.cli === "codex" ? CODEX_SCROLLBACK_LINES : CLAUDE_SCROLLBACK_LINES,
    enableWebgl: session.config.cli !== "codex",
    visible,
  });
  terminalRef.current = terminal;

  const { containerRef, setContainer } = useTerminalContainer(terminal);

  useTerminalSetup({
    claudePath,
    codexPath,
    initialized,
    observabilityEnabled,
    pty,
    respawnCounter,
    session,
    setInspectorPort,
    startTrafficLog,
    stopTrafficLog,
    terminal,
    trafficEnabled,
    trafficStartedRef,
  });

  useTerminalPanelEffects({
    containerRef,
    pty,
    sessionId: session.id,
    sessionState: session.state,
    terminal,
    visible,
  });

  const showDeadOverlay = session.state === "dead" && visible;

  // [TR-05] Hidden tabs use CSS display:none - never unmount/remount xterm.js
  return (
    <div
      className="terminal-panel"
      style={{ display: visible ? "flex" : "none" }}
    >
      {loading && visible && (
        <div className="terminal-loading">
          <div className="terminal-loading-spinner" />
          <span>Loading conversation...</span>
        </div>
      )}
      <div className="terminal-inner">
        <div className="terminal-container" ref={setContainer} />
      </div>
      {showDeadOverlay && sessionDeath.externalHolder && (
        <div className="dead-overlay">
          <div className="dead-overlay-card">
            <div className="dead-overlay-title">Session in use externally</div>
            <div className="dead-overlay-hint" style={{ marginBottom: 8 }}>
              This session is held by a process outside this app.
            </div>
            <div className="dead-overlay-actions">
              <button
                className="dead-overlay-btn dead-overlay-btn-primary"
                onClick={() => {
                  Promise.all(
                    sessionDeath.externalHolder!.map((pid) =>
                      invoke("force_kill_session_holder", { pid }).catch(() => {})
                    )
                  ).then(() => {
                    sessionDeath.setExternalHolder(null);
                    triggerRespawn();
                  });
                }}
              >
                Kill and resume
              </button>
              <button
                className="dead-overlay-btn"
                onClick={() => sessionDeath.setExternalHolder(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, terminalPanelPropsEqual);
