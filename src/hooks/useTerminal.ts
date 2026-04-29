import { useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  getTerminalKeySequenceOverride,
  SHIFT_ENTER_SEQUENCE,
} from "../lib/terminalKeyShortcuts";
import { createTerminalWriteQueue } from "../lib/terminalWriteQueue";
import { TERMINAL_FONT_FAMILY } from "./terminalShared";
import { useTerminalControls } from "./useTerminalControls";
import { useTerminalEventHandlers } from "./useTerminalEventHandlers";
import { useTerminalWriteSink } from "./useTerminalWriteSink";
import { useXtermLifecycle } from "./useXtermLifecycle";

export { getTerminalKeySequenceOverride, SHIFT_ENTER_SEQUENCE, TERMINAL_FONT_FAMILY };

interface UseTerminalOptions {
  sessionId?: string | null;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  instanceKey?: number;
  cwd?: string | null;
  scrollback?: number;
  enableWebgl?: boolean;
  visible?: boolean;
}

export function useTerminal({
  sessionId = null,
  onData,
  onResize,
  instanceKey = 0,
  cwd = null,
  scrollback = 100_000,
  enableWebgl = true,
  visible = true,
}: UseTerminalOptions = {}) {
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const onDataRef = useRef<typeof onData>(onData);
  onDataRef.current = onData;
  const cwdRef = useRef<string | null>(cwd);
  cwdRef.current = cwd;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const writeQueueRef = useRef(createTerminalWriteQueue());
  const writeInFlightRef = useRef(false);

  const xterm = useXtermLifecycle({
    cwdRef,
    enableWebgl,
    instanceKey,
    onDataRef,
    scrollback,
    sessionIdRef,
    visible,
    visibleRef,
    writeInFlightRef,
    writeQueueRef,
  });

  useTerminalEventHandlers({
    onData,
    onResize,
    sessionIdRef,
    termGeneration: xterm.termGeneration,
    termRef: xterm.termRef,
  });

  const { write, writeBytes } = useTerminalWriteSink({
    sessionIdRef,
    termRef: xterm.termRef,
    visible,
    visibleRef,
    writeInFlightRef,
    writeQueueRef,
  });

  const controls = useTerminalControls({
    sessionIdRef,
    termRef: xterm.termRef,
  });

  return {
    attach: xterm.attach,
    write,
    writeBytes,
    clear: controls.clear,
    focus: controls.focus,
    scrollToBottom: controls.scrollToBottom,
    scrollToTop: controls.scrollToTop,
    scrollToLine: controls.scrollToLine,
    isAtBottom: controls.isAtBottom,
    isAtTop: controls.isAtTop,
    fit: xterm.fit,
    getDimensions: controls.getDimensions,
    getBufferText: controls.getBufferText,
    termRef: xterm.termRef,
    webglRef: xterm.webglRef,
    ready: xterm.ready,
    termGeneration: xterm.termGeneration,
  };
}
