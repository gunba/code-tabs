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
import { annotateTapEntry, getTapCategoryLabel, type RecordedTapEntry } from "../lib/tapCatalog";
import { useRuntimeStore } from "../store/runtime";

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
  const pendingRef = useRef<RecordedTapEntry[]>([]);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const prevCatsRef = useRef<Set<string>>(new Set());
  const prevRecordingEnabledRef = useRef(false);
  const wasConnectedRef = useRef(false);

  // Read recording config from settings store
  const recordingConfig = useSettingsStore((s) => s.recordingConfig);
  const observabilityEnabled = useRuntimeStore((s) => s.observabilityInfo.observabilityEnabled);
  const recordingEnabled = observabilityEnabled && recordingConfig.taps.enabled;

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
      dlog("tap", sessionIdRef.current, `flushed ${entries.length} TAP entries`, "DEBUG", {
        event: "tap.flush",
        data: { count: entries.length },
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

  // Disk recording is independent of the Claude inspector connection. Claude
  // entries arrive after hook installation; Codex entries arrive from the
  // rollout watcher and still need periodic flushing even though no inspector
  // WebSocket exists.
  useEffect(() => {
    if (!sessionId) return;
    if (recordingEnabled) {
      startFlushTimer();
      if (!prevRecordingEnabledRef.current) {
        const categoryLabels = [...activeCats.current].map((cat) => getTapCategoryLabel(cat));
        dlog("tap", sessionId, `tap recording: ${categoryLabels.join(", ")}`, "LOG", {
          event: "tap.recording_started",
          data: { categories: categoryLabels },
        });
      }
    } else {
      stopFlushTimer();
      flush();
      if (prevRecordingEnabledRef.current) {
        dlog("tap", sessionId, "tap recording stopped", "LOG", {
          event: "tap.recording_stopped",
          data: {},
        });
      }
    }
    prevRecordingEnabledRef.current = recordingEnabled;
    return () => {
      stopFlushTimer();
      flush();
    };
  }, [sessionId, recordingEnabled, startFlushTimer, stopFlushTimer, flush]);

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
            pendingRef.current.push(annotateTapEntry(entry));
            if (pendingRef.current.length >= FLUSH_THRESHOLD) {
              flush();
            }
          }
        }
      } catch {
        dlog("tap", sid, "invalid TAP JSON line dropped", "WARN", {
          event: "tap.invalid_json",
          data: { preview: line.slice(0, 240) },
        });
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
      dlog("tap", sessionId, "taps installed (parse+stringify always-on)", "LOG", {
        event: "tap.install",
        data: {
          coreCategories: ["parse", "stringify"],
        },
      });

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
        dlog("tap", sessionId, `${getTapCategoryLabel(cat)} ${shouldBeOn ? "enabled" : "disabled"}`, "DEBUG", {
          event: "tap.category_toggle",
          data: {
            category: getTapCategoryLabel(cat),
            enabled: shouldBeOn,
          },
        });
      }
    }

    // Track effective state: only categories that are both configured AND recording is enabled
    prevCatsRef.current = recordingEnabled ? new Set(next) : new Set();
  }, [recordingConfig, connected, sessionId, wsSend, recordingEnabled]);

  // Cleanup on disconnect
  useEffect(() => {
    if (connected) {
      wasConnectedRef.current = true;
      return;
    }
    if (wasConnectedRef.current) {
      flush();
      tapsInstalledRef.current = false;
      prevCatsRef.current = new Set();
      wasConnectedRef.current = false;
    }
  }, [connected, flush]);

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
