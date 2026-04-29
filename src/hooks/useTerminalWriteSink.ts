import { useCallback, useEffect, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { dlog, shouldRecordDebugLog } from "../lib/debugLog";
import { startTraceSpan } from "../lib/perfTrace";
import {
  enqueueTerminalWrite,
  getTerminalWriteQueueDepth,
  takeTerminalWriteBatch,
  type TerminalWriteQueue,
} from "../lib/terminalWriteQueue";
import {
  captureBufferState,
  escapePreview,
  terminalOutputDecoder,
} from "./terminalShared";

interface UseTerminalWriteSinkParams {
  sessionIdRef: MutableRefObject<string | null>;
  termRef: MutableRefObject<Terminal | null>;
  visible: boolean;
  visibleRef: MutableRefObject<boolean>;
  writeInFlightRef: MutableRefObject<boolean>;
  writeQueueRef: MutableRefObject<TerminalWriteQueue>;
}

export function useTerminalWriteSink({
  sessionIdRef,
  termRef,
  visible,
  visibleRef,
  writeInFlightRef,
  writeQueueRef,
}: UseTerminalWriteSinkParams): {
  write: (data: string) => void;
  writeBytes: (data: Uint8Array) => void;
} {
  const flushWriteQueue = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // Hidden tabs keep raw output queued; xterm parsing/rendering catches up on activation.
    if (!visibleRef.current) return;
    if (writeInFlightRef.current) return;
    const queuedChunks = getTerminalWriteQueueDepth(writeQueueRef.current);
    const batch = takeTerminalWriteBatch(writeQueueRef.current);
    if (!batch) return;

    const sid = sessionIdRef.current;
    const isBytes = batch.data instanceof Uint8Array;
    const debug = shouldRecordDebugLog("DEBUG", sid);
    let decoded: string | null = null;
    const getText = () => {
      if (typeof batch.data === "string") return batch.data;
      if (decoded === null) decoded = terminalOutputDecoder.decode(batch.data);
      return decoded;
    };
    const span = startTraceSpan(isBytes ? "terminal.write_bytes_apply" : "terminal.write_text_apply", {
      module: "terminal",
      sessionId: sid,
      event: isBytes ? "terminal.write_bytes_perf" : "terminal.write_text_perf",
      emitStart: false,
      warnAboveMs: 16,
      data: () => ({
        chunkCount: batch.chunkCount,
        queueDepth: queuedChunks,
        ...(isBytes
          ? { byteLength: batch.size, preview: escapePreview(getText()) }
          : { length: batch.size, preview: escapePreview(getText()) }),
      }),
    });
    if (debug) {
      const text = getText();
      dlog("terminal", sid, isBytes ? "terminal write(bytes) batch" : "terminal write(text) batch", "DEBUG", {
        event: isBytes ? "terminal.write_bytes_batch" : "terminal.write_text_batch",
        data: {
          chunkCount: batch.chunkCount,
          queueDepth: queuedChunks,
          ...(isBytes
            ? {
                byteLength: batch.size,
                containsEscape: text.includes("\x1b"),
                containsCR: text.includes("\r"),
                containsLF: text.includes("\n"),
              }
            : { length: batch.size }),
          text,
          preview: escapePreview(text),
        },
      });
    }
    writeInFlightRef.current = true;
    try {
      term.write(batch.data, () => {
        if (termRef.current !== term) return;
        span.end(() => ({
          after: captureBufferState(term),
        }));
        if (debug) {
          dlog("terminal", sid, isBytes ? "terminal write(bytes) applied" : "terminal write(text) applied", "DEBUG", {
            event: isBytes ? "terminal.write_bytes_applied" : "terminal.write_text_applied",
            data: {
              chunkCount: batch.chunkCount,
              ...(isBytes ? { byteLength: batch.size } : { length: batch.size }),
              after: captureBufferState(term),
            },
          });
        }
        writeInFlightRef.current = false;
        queueMicrotask(flushWriteQueue);
      });
    } catch (err) {
      span.fail(err);
      writeInFlightRef.current = false;
      dlog("terminal", sid, `term.write error: ${err}`, "ERR");
      queueMicrotask(flushWriteQueue);
    }
  }, [sessionIdRef, termRef, visibleRef, writeInFlightRef, writeQueueRef]);

  useEffect(() => {
    if (visible) {
      flushWriteQueue();
    }
  }, [flushWriteQueue, visible]);

  const write = useCallback((data: string) => {
    if (!termRef.current) return;
    const sid = sessionIdRef.current;
    if (shouldRecordDebugLog("DEBUG", sid)) {
      dlog("terminal", sid, "terminal write(text) queued", "DEBUG", {
        event: "terminal.write_text_queued",
        data: {
          length: data.length,
          preview: escapePreview(data),
          queueDepth: getTerminalWriteQueueDepth(writeQueueRef.current),
        },
      });
    }
    enqueueTerminalWrite(writeQueueRef.current, data);
    flushWriteQueue();
  }, [flushWriteQueue, sessionIdRef, termRef, writeQueueRef]);

  // [PT-16] [DF-03] Write raw bytes to terminal.
  const writeBytes = useCallback((data: Uint8Array) => {
    if (!termRef.current) return;
    const sid = sessionIdRef.current;
    if (shouldRecordDebugLog("DEBUG", sid)) {
      let text: string | null = null;
      const getText = () => text ??= terminalOutputDecoder.decode(data);
      const decoded = getText();
      dlog("terminal", sid, "terminal write(bytes) queued", "DEBUG", {
        event: "terminal.write_bytes_queued",
        data: {
          byteLength: data.byteLength,
          containsEscape: decoded.includes("\x1b"),
          containsCR: decoded.includes("\r"),
          containsLF: decoded.includes("\n"),
          text: decoded,
          preview: escapePreview(decoded),
          queueDepth: getTerminalWriteQueueDepth(writeQueueRef.current),
        },
      });
    }
    enqueueTerminalWrite(writeQueueRef.current, data);
    flushWriteQueue();
  }, [flushWriteQueue, sessionIdRef, termRef, writeQueueRef]);

  return { write, writeBytes };
}
