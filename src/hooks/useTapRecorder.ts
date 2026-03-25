import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { INSTALL_TAPS, POLL_TAPS, tapToggleExpr, tapToggleAllExpr } from "../lib/inspectorHooks";
import type { TapCategory } from "../lib/inspectorHooks";
import { dlog } from "../lib/debugLog";

const POLL_INTERVAL_MS = 500;
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 50;

const ALL_CATEGORIES: TapCategory[] = ["parse", "console", "fs", "spawn", "fetch", "exit", "timer", "stdout", "require"];

interface TapEntry {
  ts: number;
  cat: string;
  [key: string]: unknown;
}

interface TapRecorderOptions {
  sessionId: string | null;
  wsSend: (method: string, params?: Record<string, unknown>) => number;
  registerExternalHandler: (handler: ((msg: Record<string, unknown>) => void) | null) => void;
  connected: boolean;
  categories: Set<string>; // empty = disabled
}

/**
 * Manages tap hook lifecycle: install, poll, batch, and flush to disk.
 * Separate from useInspectorState — shares the WebSocket via wsSend.
 */
export function useTapRecorder({
  sessionId,
  wsSend,
  registerExternalHandler,
  connected,
  categories,
}: TapRecorderOptions): void {
  const tapsInstalledRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TapEntry[]>([]);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const prevCatsRef = useRef<Set<string>>(new Set());

  const flush = useCallback(async () => {
    const entries = pendingRef.current;
    if (entries.length === 0 || !sessionIdRef.current) return;
    pendingRef.current = [];

    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    try {
      await invoke("append_tap_data", {
        sessionId: sessionIdRef.current,
        lines,
      });
    } catch (e) {
      dlog("tap", sessionIdRef.current, `flush error: ${e}`, "WARN");
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(() => {
      wsSend("Runtime.evaluate", {
        expression: POLL_TAPS,
        returnByValue: true,
      });
    }, POLL_INTERVAL_MS);
    flushTimerRef.current = setTimeout(function tick() {
      flush();
      flushTimerRef.current = setTimeout(tick, FLUSH_INTERVAL_MS);
    }, FLUSH_INTERVAL_MS);
  }, [wsSend, flush]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const handleMessage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: Record<string, any>) => {
      const val = msg.result?.result?.value;
      if (!val || !Array.isArray(val.entries)) return;
      const entries = val.entries as TapEntry[];
      if (entries.length === 0) return;
      pendingRef.current.push(...entries);
      if (pendingRef.current.length >= FLUSH_THRESHOLD) {
        flush();
      }
    },
    [flush],
  );

  // Register/unregister external handler
  useEffect(() => {
    if (categories.size > 0 && connected) {
      registerExternalHandler(handleMessage);
    }
    return () => {
      registerExternalHandler(null);
    };
  }, [categories.size > 0, connected, registerExternalHandler, handleMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync individual category flags when categories change
  useEffect(() => {
    if (!connected || !sessionId) return;
    const prev = prevCatsRef.current;
    const next = categories;

    // Install taps if first time enabling anything
    if (next.size > 0 && !tapsInstalledRef.current) {
      wsSend("Runtime.evaluate", { expression: INSTALL_TAPS, returnByValue: true });
      tapsInstalledRef.current = true;
    }

    // Toggle individual categories that changed
    for (const cat of ALL_CATEGORIES) {
      const wasOn = prev.has(cat);
      const isOn = next.has(cat);
      if (wasOn !== isOn) {
        wsSend("Runtime.evaluate", {
          expression: tapToggleExpr(cat, isOn),
          returnByValue: true,
        });
      }
    }

    // Start or stop polling based on whether any categories are active
    if (next.size > 0 && !pollTimerRef.current) {
      startPolling();
      dlog("tap", sessionId, `tap recording: ${[...next].join(",")}`);
    } else if (next.size === 0 && pollTimerRef.current) {
      stopPolling();
      flush();
      dlog("tap", sessionId, "tap recording stopped");
    }

    prevCatsRef.current = new Set(next);
  }, [categories, connected, sessionId, wsSend, startPolling, stopPolling, flush]);

  // Full cleanup on disconnect or unmount
  useEffect(() => {
    if (!connected) {
      if (pollTimerRef.current) {
        stopPolling();
        flush();
      }
      tapsInstalledRef.current = false;
      prevCatsRef.current = new Set();
    }
  }, [connected, stopPolling, flush]);

  // Cleanup on unmount: disable all flags in hooked process
  useEffect(() => {
    return () => {
      if (tapsInstalledRef.current) {
        wsSend("Runtime.evaluate", { expression: tapToggleAllExpr(false), returnByValue: true });
      }
      stopPolling();
      flush();
    };
  }, [wsSend, stopPolling, flush]);
}
