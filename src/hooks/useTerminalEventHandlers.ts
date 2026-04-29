import { useEffect, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { dlog, shouldRecordDebugLog } from "../lib/debugLog";
import { captureBufferState, escapePreview } from "./terminalShared";

interface UseTerminalEventHandlersParams {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  sessionIdRef: MutableRefObject<string | null>;
  termGeneration: number;
  termRef: MutableRefObject<Terminal | null>;
}

export function useTerminalEventHandlers({
  onData,
  onResize,
  sessionIdRef,
  termGeneration,
  termRef,
}: UseTerminalEventHandlersParams): void {
  // Wire up onData/onResize handlers (update when callbacks change)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposables: { dispose(): void }[] = [];

    if (onData) {
      disposables.push(term.onData((data) => {
        const sid = sessionIdRef.current;
        if (shouldRecordDebugLog("DEBUG", sid)) {
          dlog("terminal", sid, "terminal input", "DEBUG", {
            event: "terminal.input",
            data: {
              length: data.length,
              text: data,
              preview: escapePreview(data),
            },
          });
        }
        onData(data);
      }));
    }
    if (onResize) {
      disposables.push(term.onResize(({ cols, rows }) => {
        const sid = sessionIdRef.current;
        if (shouldRecordDebugLog("DEBUG", sid)) {
          dlog("terminal", sid, "terminal resize callback", "DEBUG", {
            event: "terminal.resize_callback",
            data: {
              cols,
              rows,
              buffer: captureBufferState(term),
            },
          });
        }
        onResize(cols, rows);
      }));
    }

    return () => disposables.forEach((d) => d.dispose());
  }, [onData, onResize, sessionIdRef, termGeneration, termRef]);
}
