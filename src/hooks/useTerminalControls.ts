import { useCallback, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { dlog } from "../lib/debugLog";
import { captureBufferState } from "./terminalShared";

const BOTTOM_TOLERANCE = 2;

interface UseTerminalControlsParams {
  sessionIdRef: MutableRefObject<string | null>;
  termRef: MutableRefObject<Terminal | null>;
}

export function useTerminalControls({
  sessionIdRef,
  termRef,
}: UseTerminalControlsParams) {
  const clear = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "terminal clear", "DEBUG", {
        event: "terminal.clear",
        data: {
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.clear();
  }, [sessionIdRef, termRef]);

  const focus = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "terminal focus", "DEBUG", {
        event: "terminal.focus",
        data: {
          buffer: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.focus();
  }, [sessionIdRef, termRef]);

  const scrollToBottom = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "scroll to bottom", "DEBUG", {
        event: "terminal.scroll_to_bottom",
        data: {
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.scrollToBottom();
  }, [sessionIdRef, termRef]);

  const scrollToTop = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "scroll to top", "DEBUG", {
        event: "terminal.scroll_to_top",
        data: {
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.scrollToTop();
  }, [sessionIdRef, termRef]);

  const scrollToLine = useCallback((line: number) => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "scroll to line", "DEBUG", {
        event: "terminal.scroll_to_line",
        data: {
          line,
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.scrollToLine(line);
  }, [sessionIdRef, termRef]);

  const isAtBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    const buf = term.buffer.active;
    return buf.baseY - buf.viewportY <= BOTTOM_TOLERANCE;
  }, [termRef]);

  const isAtTop = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    return term.buffer.active.viewportY <= 0;
  }, [termRef]);

  const getDimensions = useCallback(() => {
    const term = termRef.current;
    if (!term) return { cols: 80, rows: 24 };
    return { cols: term.cols, rows: term.rows };
  }, [termRef]);

  const getBufferText = useCallback(() => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }, [termRef]);

  return {
    clear,
    focus,
    scrollToBottom,
    scrollToTop,
    scrollToLine,
    isAtBottom,
    isAtTop,
    getDimensions,
    getBufferText,
  };
}
