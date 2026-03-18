import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminal } from "../../hooks/useTerminal";
import { usePty } from "../../hooks/usePty";
import { useClaudeState } from "../../hooks/useClaudeState";
import { useSubagentWatcher } from "../../hooks/useSubagentWatcher";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { buildClaudeArgs, getResumeId } from "../../lib/claude";
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

  let content: { icon: string; text: string | null; className: string } | null;
  switch (session.state) {
    case "thinking":
      content = { icon: "●", text: null, className: "banner-thinking" };
      break;
    case "toolUse":
      content = {
        icon: "⚙",
        text: tool || null,
        className: `banner-tool banner-tool-${(tool || "").toLowerCase()}`,
      };
      break;
    case "waitingPermission":
      content = { icon: "⏸", text: null, className: "banner-permission" };
      break;
    case "error":
      content = { icon: "⚠", text: null, className: "banner-error" };
      break;
    default:
      content = null;
  }

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

function useDurationTimer(sessionId: string, state: SessionState) {
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
  const isResumed = !!session.config.resumeSession;
  const watchedJsonlIdRef = useRef(getResumeId(session));

  // When a result event fires (conversation ended) but the PTY is still alive,
  // check if Claude forked into a new JSONL file (plan mode, continuation).
  // The new file's first events reference the old sessionId — this is how we link them.
  const handleConversationEnd = useCallback(() => {
    if (session.state === "dead") return;
    invoke<string | null>("find_continuation_session", {
      sessionId: watchedJsonlIdRef.current,
      workingDir: session.config.workingDir,
    }).then((newJsonlId) => {
      if (newJsonlId && newJsonlId !== watchedJsonlIdRef.current) {
        invoke("stop_jsonl_watcher", { sessionId: session.id });
        invoke("start_jsonl_watcher", {
          sessionId: session.id,
          workingDir: session.config.workingDir,
          jsonlSessionId: newJsonlId,
        });
        watchedJsonlIdRef.current = newJsonlId;
      }
    }).catch(() => {});
  }, [session.id, session.state, session.config.workingDir]);

  const handleCaughtUp = useCallback(() => setLoading(false), []);
  const { feed } = useClaudeState(session.id, isResumed, { onConversationEnd: handleConversationEnd, onCaughtUp: handleCaughtUp });
  const [loading, setLoading] = useState(isResumed);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [queuedInput, setQueuedInput] = useState<string | null>(null);

  // Start subagent JSONL watcher — uses the app's session ID directly.
  // For new sessions: --session-id matches, subagents go under our ID's dir.
  // For resumed sessions: subagents from the NEW conversation go under the new ID.
  // Pass resumeSession as the JSONL session ID for subagent directory lookup.
  // Subagents live under the CLI's session ID, not our internal app ID.
  useSubagentWatcher(session.id, session.config.workingDir, session.config.resumeSession || session.config.sessionId || null);

  // Duration timer
  useDurationTimer(session.id, session.state);

  const decoder = useRef(new TextDecoder());

  // Use a ref to break the circular dependency:
  // handlePtyData needs terminal, terminal needs handleTermData, which needs pty,
  // and pty needs handlePtyData. We use terminalRef to avoid forward-referencing.
  const terminalRef = useRef<ReturnType<typeof useTerminal> | null>(null);
  // Buffer PTY data for background tabs — skip xterm.js writes when not visible,
  // flush in one write when the tab becomes visible. Saves O(N) rendering cost.
  const visibleRef = useRef(visible);
  const bgBufferRef = useRef<Uint8Array[]>([]);
  visibleRef.current = visible;

  const handlePtyData = useCallback(
    (data: Uint8Array) => {
      const text = decoder.current.decode(data, { stream: true });
      // Always feed text for JSONL state/permission detection regardless of visibility
      feed(text);
      // Only write to xterm.js if the tab is visible; buffer otherwise
      if (visibleRef.current) {
        terminalRef.current?.writeBytes(data);
      } else {
        bgBufferRef.current.push(data);
      }
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

  // Track user input for slash command detection
  const inputBufRef = useRef("");
  const recordCommandUsage = useSettingsStore((s) => s.recordCommandUsage);

  const handleTermData = useCallback(
    (data: string) => {
      pty.handle.current?.write(data);
      // Buffer user input to detect slash commands typed directly in terminal
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const trimmed = inputBufRef.current.trim();
          if (trimmed.startsWith("/") && trimmed.length >= 3 && !trimmed.includes(" ")) {
            recordCommandUsage(trimmed);
          }
          inputBufRef.current = "";
        } else if (ch === "\x7f" || ch === "\b") {
          // Backspace
          inputBufRef.current = inputBufRef.current.slice(0, -1);
        } else if (ch >= " ") {
          inputBufRef.current += ch;
        }
      }
    },
    // pty.handle is a stable ref — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recordCommandUsage]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      pty.handle.current?.resize(cols, rows);
    },
    // pty.handle is a stable ref — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
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
        // Normalize path slashes for Windows PTY spawn
        const cwd = session.config.workingDir.replace(/\//g, "\\");
        const handle = pty.spawn(claudePath, args, cwd, cols, rows);
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

    const timer = setTimeout(doSpawn, 50);
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

  // Re-fit and focus when becoming visible — only depends on visible and session.id.
  // terminal is NOT in deps because useTerminal returns a new object on every render,
  // which would cause this effect to re-fire on every store update, calling fit()
  // repeatedly and flashing the terminal.
  useEffect(() => {
    if (visible) {
      // Flush background buffer — write all buffered data in one batch
      const chunks = bgBufferRef.current;
      if (chunks.length > 0) {
        bgBufferRef.current = [];
        let totalLen = 0;
        for (const c of chunks) totalLen += c.length;
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.length; }
        terminal.termRef.current?.write(merged);
      }
      terminal.fit();
      terminal.termRef.current?.scrollToBottom();
      terminal.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.id]);

  // Queue input handler: capture typed text, or cancel if already queued
  const handleQueueInput = useCallback(() => {
    if (queuedInput) {
      setQueuedInput(null);
      return;
    }
    const text = inputBufRef.current.trim();
    if (!text) return;
    inputBufRef.current = "";
    pty.handle.current?.write("\x15"); // Clear terminal input line
    setQueuedInput(text);
    // pty.handle is a stable ref — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedInput]);

  // Auto-send queued input when session becomes idle, clear if session dies
  useEffect(() => {
    if (!queuedInput) return;
    if (session.state === "dead") { setQueuedInput(null); return; }
    if (session.state !== "idle") return;
    const timer = setTimeout(() => {
      pty.handle.current?.write(queuedInput + "\r");
      setQueuedInput(null);
    }, 800);
    return () => clearTimeout(timer);
    // pty.handle is a stable ref — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.state, queuedInput]);

  // Poll scroll position to show/hide scroll-to-bottom button
  useEffect(() => {
    if (!visible) return;
    const check = () => setShowScrollBtn(!terminal.isAtBottom());
    const interval = setInterval(check, 300);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Reclaim focus when terminal is visible but loses it to non-interactive elements.
  // Uses termRef directly instead of terminal (which is a new object every render).
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const handleFocusOut = () => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
        // Don't reclaim focus if a modal overlay is open
        if (document.querySelector('.launcher-overlay, .resume-picker-overlay, .hooks-overlay, .palette-overlay')) return;
        terminal.termRef.current?.focus();
      });
    };

    const container = containerRef.current;
    container?.addEventListener("focusout", handleFocusOut);
    return () => {
      cancelled = true;
      container?.removeEventListener("focusout", handleFocusOut);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.id]);

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
      {showScrollBtn && (
        <button
          className="scroll-to-bottom-btn"
          onClick={() => terminal.scrollToBottom()}
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}
      {!showScrollBtn && visible && (
        <div className="clear-input-zone">
          <button
            className={`queue-input-btn${queuedInput ? " queue-input-btn-active" : ""}`}
            onClick={handleQueueInput}
            title={queuedInput ? `Queued: "${queuedInput}" (click to cancel)` : "Queue input for idle send"}
          >
            ⏎
          </button>
          <button
            className="clear-input-btn"
            onClick={() => pty.handle.current?.write("\x15")}
            title="Clear input line (Ctrl+U)"
          >
            ⌫
          </button>
        </div>
      )}
    </div>
  );
}
