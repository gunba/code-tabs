import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { findNearestLiveTab } from "../../lib/claude";
import { dlog, shouldRecordDebugLog } from "../../lib/debugLog";
import { useSessionStore } from "../../store/sessions";
import type { TerminalController } from "./terminalPanelTypes";

const EARLY_OUTPUT_LIMIT_BYTES = 4096;
const ptyOutputDecoder = new TextDecoder();

function escapeChunkPreview(text: string): string {
  return text
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .slice(0, 240);
}

interface UseSessionDeathParams {
  sessionId: string;
  resumeId: string;
  terminalRef: MutableRefObject<TerminalController | null>;
  triggerRespawnRef: MutableRefObject<() => void>;
}

interface SessionDeath {
  externalHolder: number[] | null;
  handlePtyData: (data: Uint8Array) => void;
  handlePtyExit: (info: { exitCode: number }) => void;
  resetSessionInUseDetection: () => void;
  setExternalHolder: (holder: number[] | null) => void;
}

export function useSessionDeath({
  sessionId,
  resumeId,
  terminalRef,
  triggerRespawnRef,
}: UseSessionDeathParams): SessionDeath {
  const updateState = useSessionStore((s) => s.updateState);
  const earlyOutputRef = useRef("");
  const earlyOutputBytesRef = useRef(0);
  const sessionInUseRef = useRef(false);
  const sessionInUseRetried = useRef(false);
  const [externalHolder, setExternalHolder] = useState<number[] | null>(null);

  const resetSessionInUseDetection = useCallback(() => {
    earlyOutputRef.current = "";
    earlyOutputBytesRef.current = 0;
    sessionInUseRef.current = false;
    sessionInUseRetried.current = false;
  }, []);

  const handlePtyData = useCallback(
    (data: Uint8Array) => {
      const debug = shouldRecordDebugLog("DEBUG", sessionId);
      let text: string | null = null;
      const getText = () => text ??= ptyOutputDecoder.decode(data);
      if (debug) {
        const decoded = getText();
        dlog("pty", sessionId, "PTY output received", "DEBUG", {
          event: "pty.output",
          data: {
            byteLength: data.byteLength,
            containsEscape: decoded.includes("\x1b"),
            text: decoded,
            preview: escapeChunkPreview(decoded),
          },
        });
      }
      // Accumulate early output for error detection (first ~4KB)
      if (earlyOutputBytesRef.current < EARLY_OUTPUT_LIMIT_BYTES && !sessionInUseRef.current) {
        const remainingBytes = EARLY_OUTPUT_LIMIT_BYTES - earlyOutputBytesRef.current;
        const earlySlice = data.byteLength <= remainingBytes ? data : data.subarray(0, remainingBytes);
        earlyOutputBytesRef.current += earlySlice.byteLength;
        earlyOutputRef.current += earlySlice.byteLength === data.byteLength
          ? getText()
          : ptyOutputDecoder.decode(earlySlice);
        if (/already in use/i.test(earlyOutputRef.current)) {
          dlog("terminal", sessionId, "session-in-use marker detected in PTY output", "WARN", {
            event: "session.session_in_use_detected",
            data: {
              preview: escapeChunkPreview(earlyOutputRef.current),
            },
          });
          sessionInUseRef.current = true;
        }
      }
      terminalRef.current?.writeBytes(data);
    },
    [sessionId, terminalRef]
  );

  const handlePtyExit = useCallback(
    (info: { exitCode: number }) => {
      dlog("terminal", sessionId, `exit code=${info.exitCode}`, "LOG", {
        event: "session.exit",
        data: { exitCode: info.exitCode },
      });
      // Restore text selection in dead terminal (ConPTY may not pass through
      // the disable sequences that Claude Code sends on exit)
      terminalRef.current?.write("\x1b[?1003l\x1b[?1006l");
      // Stop TCP tap server immediately (before any early-return paths)
      invoke("stop_tap_server", { sessionId }).catch(() => {});
      invoke("stop_codex_rollout", { sessionId }).catch(() => {});
      // [DS-07] [RS-06] Session-in-use auto-recovery: kill own orphans, retry; show overlay for external
      if (sessionInUseRef.current && !sessionInUseRetried.current) {
        sessionInUseRef.current = false;
        sessionInUseRetried.current = true;
        earlyOutputRef.current = "";
        earlyOutputBytesRef.current = 0;

        invoke<{ killed: number; external: number[] }>("kill_session_holder", { sessionId: resumeId })
          .then((result) => {
            if (result.external.length > 0 && result.killed === 0) {
              // Held by external process - ask user before killing
              dlog("terminal", sessionId, "session held by external process", "WARN", {
                event: "session.external_holder_detected",
                data: {
                  externalPids: result.external,
                  killedOwnedPids: result.killed,
                },
              });
              setExternalHolder(result.external);
              updateState(sessionId, "dead");
            } else {
              // Killed our own orphans (or mixed) - retry
              dlog("terminal", sessionId, "retrying after killing stale holder", "LOG", {
                event: "session.retry_after_holder_cleanup",
                data: {
                  externalPids: result.external,
                  killedOwnedPids: result.killed,
                },
              });
              terminalRef.current?.write(
                "\r\n\x1b[90m[Killed stale session, retrying...]\x1b[0m\r\n"
              );
              triggerRespawnRef.current();
            }
          })
          .catch(() => {
            updateState(sessionId, "dead");
          });
        return;
      }
      // Cascade dead state to all subagents so they get cleaned up from canvas
      const subagents = useSessionStore.getState().subagents.get(sessionId) || [];
      const { updateSubagent } = useSessionStore.getState();
      for (const sub of subagents) {
        updateSubagent(sessionId, sub.id, { state: "dead" });
      }
      updateState(sessionId, "dead");
      // [DS-01] Switch away from dead tab to nearest live tab via findNearestLiveTab
      const store = useSessionStore.getState();
      if (store.activeTabId === sessionId) {
        const idx = store.sessions.findIndex((x) => x.id === sessionId);
        const next = findNearestLiveTab(store.sessions, idx);
        if (next && next !== sessionId) store.setActiveTab(next);
      }
    },
    [resumeId, sessionId, terminalRef, triggerRespawnRef, updateState]
  );

  return {
    externalHolder,
    handlePtyData,
    handlePtyExit,
    resetSessionInUseDetection,
    setExternalHolder,
  };
}
