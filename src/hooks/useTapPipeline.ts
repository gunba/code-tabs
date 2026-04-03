import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { INSTALL_TAPS, tapToggleExpr, tapToggleAllExpr } from "../lib/inspectorHooks";
import type { TapCategory } from "../lib/inspectorHooks";
import { classifyTapEntry } from "../lib/tapClassifier";
import { tapEventBus } from "../lib/tapEventBus";
import { dlog } from "../lib/debugLog";
import { useSettingsStore } from "../store/settings";
import type { TapEntry } from "../types/tapEvents";

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 50;

const ALL_CATEGORIES: TapCategory[] = ["parse", "stringify", "console", "fs", "spawn", "fetch", "exit", "timer", "stdout", "stderr", "require", "bun", "websocket", "net", "stream", "fspromises", "bunfile", "abort", "fswatch", "textdecoder", "events", "envproxy"];

interface TapPipelineOptions {
  sessionId: string | null;
  wsSend: (method: string, params?: Record<string, unknown>) => number;
  connected: boolean;
}

// [IN-10] Tap event pipeline: TCP -> classify -> dispatch -> disk
// [SI-14] Push-based: events arrive via Tauri events from Rust TCP tap server
/**
 * Manages the tap pipeline: install hooks via inspector WebSocket,
 * receive events via dedicated TCP channel (Tauri events),
 * classify into typed events, dispatch to tapEventBus, and buffer for disk recording.
 *
 * Core categories (parse, stringify) are always on for state detection.
 * Recording config from settings store controls disk writing and optional categories.
 */
export function useTapPipeline({
  sessionId,
  wsSend,
  connected,
}: TapPipelineOptions): void {
  const tapsInstalledRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TapEntry[]>([]);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const prevCatsRef = useRef<Set<string>>(new Set());

  // Read recording config from settings store
  const recordingConfig = useSettingsStore((s) => s.recordingConfig);
  const recordingEnabled = recordingConfig.taps.enabled;

  // Derive active categories from global config
  const activeCats = useRef(new Set<string>());
  activeCats.current = new Set(
    Object.entries(recordingConfig.taps.categories)
      .filter(([, v]) => v)
      .map(([k]) => k)
  );

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

  const startFlushTimer = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(function tick() {
      flush();
      flushTimerRef.current = setTimeout(tick, FLUSH_INTERVAL_MS);
    }, FLUSH_INTERVAL_MS);
  }, [flush]);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Listen for tap events from the Rust TCP server via session-scoped Tauri events
  useEffect(() => {
    if (!sessionId) return;
    const sid = sessionId;

    const unlisten = listen<string>(`tap-entry-${sid}`, (event) => {
      const line = event.payload;
      try {
        const entry = JSON.parse(line) as TapEntry;

        // 1. Classify -> dispatch (always, drives state)
        const classified = classifyTapEntry(entry);
        if (classified && sessionIdRef.current) {
          tapEventBus.dispatch(sessionIdRef.current, classified);
        }

        // 2. Buffer for disk (only if recording enabled)
        if (recordingEnabled) {
          const cat = entry.cat;
          const isCoreCat = cat === "parse" || cat === "stringify";
          if (isCoreCat || activeCats.current.has(cat)) {
            pendingRef.current.push(entry);
            if (pendingRef.current.length >= FLUSH_THRESHOLD) {
              flush();
            }
          }
        }
      } catch {
        // Invalid JSON line — skip
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionId, flush, recordingEnabled]);

  // Install taps on first connect + sync category flags from global config
  useEffect(() => {
    if (!connected || !sessionId) return;
    const prev = prevCatsRef.current;
    const next = activeCats.current;

    // Always install taps on connect (parse+stringify are always-on for state)
    if (!tapsInstalledRef.current) {
      wsSend("Runtime.evaluate", { expression: INSTALL_TAPS, returnByValue: true });
      tapsInstalledRef.current = true;
      dlog("tap", sessionId, "taps installed (parse+stringify always-on)");

      // Diagnostic: check TCP connection state after a short delay
      const diagSid = sessionId;
      setTimeout(() => {
        const diagId = wsSend("Runtime.evaluate", {
          expression: "JSON.stringify(globalThis.__tapDiag || 'no-diag')",
          returnByValue: true,
        });
        dlog("tap", diagSid, `tap diag requested (msgId=${diagId})`, "DEBUG");
      }, 2000);
    }

    // Toggle individual optional categories that changed.
    // When recording is disabled, force all optional hooks off to avoid overhead.
    for (const cat of ALL_CATEGORIES) {
      if (cat === "parse" || cat === "stringify") continue; // always on
      const wasOn = prev.has(cat);
      const shouldBeOn = recordingEnabled && next.has(cat);
      if (wasOn !== shouldBeOn) {
        wsSend("Runtime.evaluate", {
          expression: tapToggleExpr(cat, shouldBeOn),
          returnByValue: true,
        });
      }
    }

    // Start or stop disk flush timer based on recording state
    if (recordingEnabled && !flushTimerRef.current) {
      startFlushTimer();
      dlog("tap", sessionId, `tap recording: ${[...next].join(",")}`);
    } else if (!recordingEnabled && flushTimerRef.current) {
      stopFlushTimer();
      flush();
      dlog("tap", sessionId, "tap recording stopped");
    }

    // Track effective state: only categories that are both configured AND recording is enabled
    prevCatsRef.current = recordingEnabled ? new Set(next) : new Set();
  }, [recordingConfig, connected, sessionId, wsSend, startFlushTimer, stopFlushTimer, flush, recordingEnabled]);

  // Cleanup on disconnect
  useEffect(() => {
    if (!connected) {
      stopFlushTimer();
      flush();
      tapsInstalledRef.current = false;
      prevCatsRef.current = new Set();
    }
  }, [connected, stopFlushTimer, flush]);

  // Cleanup on unmount: disable optional flags, flush pending
  useEffect(() => {
    return () => {
      if (tapsInstalledRef.current) {
        wsSend("Runtime.evaluate", { expression: tapToggleAllExpr(false), returnByValue: true });
      }
      stopFlushTimer();
      flush();
    };
  }, [wsSend, stopFlushTimer, flush]);
}
