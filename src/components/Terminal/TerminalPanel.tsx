import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminal } from "../../hooks/useTerminal";
import { usePty } from "../../hooks/usePty";
import { useClaudeState } from "../../hooks/useClaudeState";
import { useSubagentWatcher } from "../../hooks/useSubagentWatcher";
import { useSessionStore } from "../../store/sessions";
import { buildClaudeArgs } from "../../lib/claude";
import { registerPtyWriter, unregisterPtyWriter } from "../../lib/ptyRegistry";
import { registerBufferReader, unregisterBufferReader } from "../../lib/terminalRegistry";
import type { Session, SessionState } from "../../types/session";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

interface TerminalPanelProps {
  session: Session;
  visible: boolean;
}

// ── State Banner ────────────────────────────────────────────────────────
// Low-text: icon-first, tool name is acceptable (it's a value)

function StateBanner({ session }: { session: Session }) {
  const tool = session.metadata.currentToolName;

  const bannerContent = (): { icon: string; text: string | null; className: string } | null => {
    switch (session.state) {
      case "thinking":
        return { icon: "●", text: null, className: "banner-thinking" };
      case "toolUse":
        return {
          icon: "⚙",
          text: tool || null,
          className: `banner-tool banner-tool-${(tool || "").toLowerCase()}`,
        };
      case "waitingPermission":
        return { icon: "⏸", text: null, className: "banner-permission" };
      case "error":
        return { icon: "⚠", text: null, className: "banner-error" };
      default:
        return null;
    }
  };

  const content = bannerContent();
  if (!content) return null;

  return (
    <div className={`state-banner ${content.className}`}>
      <span className="banner-icon">{content.icon}</span>
      {content.text && <span>{content.text}</span>}
    </div>
  );
}

// ── Duration Timer (active time only) ────────────────────────────────────

const ACTIVE_STATES = new Set<SessionState>(["thinking", "toolUse", "waitingPermission", "error"]);

function useDurationTimer(sessionId: string, _createdAt: string, state: SessionState) {
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const accumulatedRef = useRef(0);
  const lastTickRef = useRef(Date.now());
  const lastStateRef = useRef(state);

  // Track state changes so we know when we transition active↔idle
  lastStateRef.current = state;

  useEffect(() => {
    if (state === "dead") return;

    const interval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      if (ACTIVE_STATES.has(lastStateRef.current)) {
        accumulatedRef.current += dt;
        const secs = Math.floor(accumulatedRef.current);
        updateMetadata(sessionId, { durationSecs: secs });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [sessionId, state === "dead", updateMetadata]);

  return Math.floor(accumulatedRef.current);
}

// ── Terminal Panel ──────────────────────────────────────────────────────

export function TerminalPanel({ session, visible }: TerminalPanelProps) {
  const claudePath = useSessionStore((s) => s.claudePath);
  const updateState = useSessionStore((s) => s.updateState);
  const spawnedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { feed, caughtUp } = useClaudeState(session.id);
  const [loading, setLoading] = useState(true);

  // Clear loading spinner when JSONL watcher catches up
  useEffect(() => {
    if (caughtUp.current) { setLoading(false); return; }
    const interval = setInterval(() => {
      if (caughtUp.current) { setLoading(false); clearInterval(interval); }
    }, 200);
    return () => clearInterval(interval);
  }, [caughtUp]);

  // Start subagent JSONL watcher — uses the app's session ID directly.
  // For new sessions: --session-id matches, subagents go under our ID's dir.
  // For resumed sessions: subagents from the NEW conversation go under the new ID.
  useSubagentWatcher(session.id, session.config.workingDir);

  // Duration timer
  useDurationTimer(session.id, session.createdAt, session.state);

  const decoder = useRef(new TextDecoder());

  // Use a ref to break the circular dependency:
  // handlePtyData needs terminal, terminal needs handleTermData, which needs pty,
  // and pty needs handlePtyData. We use terminalRef to avoid forward-referencing.
  const terminalRef = useRef<ReturnType<typeof useTerminal> | null>(null);

  const handlePtyData = useCallback(
    (data: Uint8Array) => {
      const text = decoder.current.decode(data, { stream: true });
      terminalRef.current?.writeBytes(data);
      feed(text);
    },
    [feed]
  );

  const handlePtyExit = useCallback(
    (_info: { exitCode: number }) => {
      // Cascade dead state to all subagents so they get cleaned up from canvas
      const subagents = useSessionStore.getState().subagents.get(session.id) || [];
      const { updateSubagent } = useSessionStore.getState();
      for (const sub of subagents) {
        updateSubagent(session.id, sub.id, { state: "dead" });
      }
      updateState(session.id, "dead");
      terminalRef.current?.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
    },
    [session.id, updateState]
  );

  const pty = usePty({ onData: handlePtyData, onExit: handlePtyExit });

  const handleTermData = useCallback(
    (data: string) => {
      pty.handle.current?.write(data);
    },
    [pty.handle]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      pty.handle.current?.resize(cols, rows);
    },
    [pty.handle]
  );

  const terminal = useTerminal({
    onData: handleTermData,
    onResize: handleResize,
  });
  terminalRef.current = terminal;

  // Attach terminal to container
  const setContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      terminal.attach(el);
    },
    [terminal]
  );

  // Spawn PTY once + start JSONL watcher
  useEffect(() => {
    if (spawnedRef.current || !claudePath || session.state === "dead") return;

    const doSpawn = async () => {
      spawnedRef.current = true;
      try {
        const args = await buildClaudeArgs(session.config);
        const { cols, rows } = terminal.getDimensions();
        const handle = pty.spawn(claudePath, args, session.config.workingDir, cols, rows);
        registerPtyWriter(session.id, handle.write);
        updateState(session.id, "idle");

        // Start JSONL file watcher for structured metadata.
        // For resumed sessions, watch the original session's JSONL file.
        invoke("start_jsonl_watcher", {
          sessionId: session.id,
          workingDir: session.config.workingDir,
          jsonlSessionId: session.config.resumeSession || null,
        });
      } catch (err) {
        console.error("Failed to spawn PTY:", err);
        updateState(session.id, "error");
        terminal.write(
          `\r\n\x1b[31mFailed to start Claude: ${err}\x1b[0m\r\n`
        );
      }
    };

    const timer = setTimeout(doSpawn, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudePath, session.id]);

  // Register terminal buffer reader for transcript export
  useEffect(() => {
    registerBufferReader(session.id, terminal.getBufferText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, terminal.getBufferText]);

  // Cleanup PTY, JSONL watcher, and terminal registry on unmount
  useEffect(() => {
    const id = session.id;
    return () => {
      invoke("stop_jsonl_watcher", { sessionId: id });
      unregisterPtyWriter(id);
      unregisterBufferReader(id);
      pty.cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit and focus when becoming visible
  useEffect(() => {
    if (visible) {
      terminal.fit();
      terminal.focus();
    }
  }, [visible, terminal, session.id]);

  // Reclaim focus when terminal is visible but loses it to non-interactive elements.
  useEffect(() => {
    if (!visible) return;

    const handleFocusOut = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
        // Don't reclaim focus if a modal overlay is open
        if (document.querySelector('.launcher-overlay, .resume-picker-overlay, .hooks-overlay, .palette-overlay')) return;
        terminal.focus();
      });
    };

    const container = containerRef.current;
    container?.addEventListener("focusout", handleFocusOut);
    return () => container?.removeEventListener("focusout", handleFocusOut);
  }, [visible, terminal]);

  return (
    <div
      className="terminal-panel"
      style={{ display: visible ? "flex" : "none" }}
    >
      <StateBanner session={session} />
      {loading && visible && (
        <div className="terminal-loading">
          <div className="terminal-loading-spinner" />
          <span>Loading conversation...</span>
        </div>
      )}
      <div className="terminal-container" ref={setContainer} />
    </div>
  );
}
