import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useActivityStore } from "../store/activity";
import type { SessionState } from "../types/session";
import { dlog } from "../lib/debugLog";

interface FsChangeEvent {
  sessionId: string;
  path: string;
  kind: string;
  timestampMs: number;
}

export function useFileWatcher(
  sessionId: string | null,
  workingDir: string | null,
  sessionState: SessionState,
) {
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || !workingDir || sessionState === "dead") {
      // Stop watcher if session died
      if (startedRef.current) {
        invoke("stop_file_watcher", { sessionId: startedRef.current }).catch(() => {});
        startedRef.current = null;
      }
      return;
    }

    // Start watcher
    invoke("start_file_watcher", { sessionId, rootDir: workingDir })
      .then(() => {
        startedRef.current = sessionId;
        dlog("watcher", sessionId, `File watcher started for ${workingDir}`);
      })
      .catch((err: unknown) => {
        dlog("watcher", sessionId, `Failed to start file watcher: ${err}`, "WARN");
      });

    // Listen for filesystem change events
    const unlistenPromise = listen<FsChangeEvent>(
      `fs-change-${sessionId}`,
      (event) => {
        const { path, kind } = event.payload;
        const store = useActivityStore.getState();

        // Try to confirm an existing unconfirmed TAP-predicted entry
        store.confirmFileChange(sessionId, path);

        // Check if this is an unpredicted change (no matching TAP entry)
        const activity = store.sessions[sessionId];
        if (activity) {
          const turns = activity.turns;
          const currentTurn = turns.length > 0 ? turns[turns.length - 1] : null;
          const hasMatch = currentTurn?.files.some(
            (f) => f.path === path && f.confirmed,
          );
          if (!hasMatch && kind !== "modified") {
            // Unpredicted fs-only change
            const fsKind =
              kind === "created"
                ? "created"
                : kind === "deleted"
                  ? "deleted"
                  : "modified";
            store.addFileActivity(sessionId, path, fsKind as "created" | "modified" | "deleted");
          }
        }
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      if (startedRef.current === sessionId) {
        invoke("stop_file_watcher", { sessionId }).catch(() => {});
        startedRef.current = null;
      }
    };
  }, [sessionId, workingDir, sessionState]);
}
