import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { dlog } from "../../lib/debugLog";
import { unregisterInspectorCallbacks, unregisterInspectorPort } from "../../lib/inspectorPort";
import {
  unregisterPtyHandleId,
  unregisterPtyKill,
  unregisterPtyWriter,
} from "../../lib/ptyRegistry";
import {
  registerBufferReader,
  registerTerminal,
  unregisterBufferReader,
  unregisterTerminal,
} from "../../lib/terminalRegistry";
import { useSessionStore } from "../../store/sessions";
import type { SessionState } from "../../types/session";
import type { PtyController, TerminalController } from "./terminalPanelTypes";

interface UseTerminalPanelEffectsParams {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  pty: PtyController;
  sessionId: string;
  sessionState: SessionState;
  terminal: TerminalController;
  visible: boolean;
}

export function useTerminalPanelEffects({
  containerRef,
  pty,
  sessionId,
  sessionState,
  terminal,
  visible,
}: UseTerminalPanelEffectsParams): void {
  const killRequest = useSessionStore((s) => s.killRequest);
  const clearKillRequest = useSessionStore((s) => s.clearKillRequest);

  // Register terminal buffer reader and terminal instance for search/render-wait
  useEffect(() => {
    registerBufferReader(sessionId, terminal.getBufferText);
    if (terminal.termRef.current) {
      registerTerminal(sessionId, terminal.termRef.current);
    }
    return () => {
      unregisterBufferReader(sessionId);
      unregisterTerminal(sessionId);
    };
  }, [sessionId, terminal.getBufferText, terminal.termGeneration, terminal.termRef]);

  // Cleanup PTY and registries on unmount
  useEffect(() => {
    const id = sessionId;
    return () => {
      invoke("stop_tap_server", { sessionId: id }).catch(() => {});
      invoke("stop_codex_rollout", { sessionId: id }).catch(() => {});
      unregisterPtyWriter(id);
      unregisterPtyKill(id);
      unregisterPtyHandleId(id);
      unregisterInspectorPort(id);
      unregisterInspectorCallbacks(id);
      dlog("terminal", id, "terminal panel unmount cleanup", "DEBUG", {
        event: "terminal.unmount_cleanup",
        data: { sessionId: id },
      });
      pty.cleanup();
    };
  }, [pty.cleanup, sessionId]);

  // Watch for kill requests from the tab bar
  useEffect(() => {
    if (killRequest === sessionId && sessionState !== "dead") {
      clearKillRequest();
      dlog("terminal", sessionId, "kill effect triggered");
      pty.cleanup();
      // pty.kill() fires exitCallback -> handlePtyExit -> state "dead"
    }
  }, [killRequest, sessionId, sessionState, clearKillRequest, pty.cleanup]);

  // Keep focus on the visible terminal; attach/fit is handled by the terminal lifecycle.
  useEffect(() => {
    if (!visible) return;
    dlog("terminal", sessionId, "panel became visible", "DEBUG", {
      event: "terminal.visible",
      data: { visible },
    });
    terminal.focus();
  }, [visible, sessionId, terminal.focus, terminal.termGeneration]);

  // Reclaim focus when terminal is visible but loses it to non-interactive elements.
  // Uses termRef directly instead of terminal (which is a new object every render).
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const overlaySelector = "[data-modal-overlay], .launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay, .diff-panel";
    const interactiveSelector = "button, input, textarea, select, [role=button], [role=tab], a[href], [contenteditable=true]";

    const handleFocusOut = () => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        const active = document.activeElement as HTMLElement | null;
        if (document.querySelector(overlaySelector)) return;
        if (active?.closest(".right-panel") && active.matches(interactiveSelector)) return;
        if (active?.matches("input, textarea, select, [contenteditable=true]")) return;
        terminal.termRef.current?.focus();
      });
    };

    const container = containerRef.current;
    container?.addEventListener("focusout", handleFocusOut);
    return () => {
      cancelled = true;
      container?.removeEventListener("focusout", handleFocusOut);
    };
  }, [visible, sessionId, containerRef, terminal.termRef]);
}

export function useTerminalContainer(terminal: TerminalController): {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  setContainer: (el: HTMLDivElement | null) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      terminal.attach(el);
    },
    [terminal.attach]
  );

  return { containerRef, setContainer };
}
