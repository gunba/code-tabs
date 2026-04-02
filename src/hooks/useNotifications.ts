import { useEffect, useRef } from "react";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { isSessionIdle } from "../types/session";
import { getEffectiveState } from "../lib/claude";

/**
 * Sends native desktop notifications when background sessions
 * need attention — response completed, permission required, or error.
 *
 * Only notifies for sessions that are NOT the currently active/visible session.
 * Rate-limited to avoid notification spam (max one per session per 30s).
 *
 * Clicking a notification switches to the target tab and focuses the window.
 * [WN-03] Rate-limited 1/session/30s. Rust WinRT toast with on_activated callback.
 */
export function useNotifications() {
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const permissionCheckedRef = useRef(false);
  const permissionGrantedRef = useRef(false);
  const lastNotifyRef = useRef<Record<string, number>>({});

  // Check/request permission once on mount
  useEffect(() => {
    if (!notificationsEnabled || permissionCheckedRef.current) return;
    permissionCheckedRef.current = true;

    (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      permissionGrantedRef.current = granted;
    })();
  }, [notificationsEnabled]);

  // Listen for notification clicks → switch tab + focus window
  useEffect(() => {
    const unlisten = listen<string>("notification-clicked", (event) => {
      const sessionId = event.payload;
      const store = useSessionStore.getState();
      if (!store.sessions.some((s) => s.id === sessionId)) return;

      store.setActiveTab(sessionId);

      const win = getCurrentWindow();
      win.unminimize().then(() => win.show()).then(() => win.setFocus()).catch(() => {});
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Subscribe to session state changes
  useEffect(() => {
    if (!notificationsEnabled) return;

    const prevStates: Record<string, string> = {};
    const COOLDOWN_MS = 30_000;

    const unsub = useSessionStore.subscribe((state) => {
      if (!permissionGrantedRef.current) return;

      const activeTabId = state.activeTabId;
      const now = Date.now();

      for (const session of state.sessions) {
        if (session.isMetaAgent) continue;

        // Use effective state to account for active subagents
        const subs = state.subagents.get(session.id) || [];
        const effState = getEffectiveState(session.state, subs);
        const prev = prevStates[session.id];
        prevStates[session.id] = effState;

        // Skip the first observation (no previous state to compare)
        if (!prev) continue;
        // Skip if this is the active session
        if (session.id === activeTabId) continue;
        // Skip if we recently notified for this session
        if (lastNotifyRef.current[session.id] && now - lastNotifyRef.current[session.id] < COOLDOWN_MS) continue;
        // Skip if effective state didn't change
        if (prev === effState) continue;

        let title: string | null = null;
        let body: string | null = null;

        if ((prev === "thinking" || prev === "toolUse") && isSessionIdle(effState)) {
          title = `${session.name} — Response Complete`;
          body = session.metadata.currentAction || "Session is ready for input.";
        } else if (session.state === "actionNeeded") {
          title = `${session.name} — Action Needed`;
          body = "A session needs your input.";
        } else if (session.state === "waitingPermission") {
          title = `${session.name} — Permission Required`;
          body = "A session needs your permission to continue.";
        } else if (session.state === "error") {
          title = `${session.name} — Error`;
          body = "A session encountered an error.";
        }

        if (title && body) {
          lastNotifyRef.current[session.id] = now;
          invoke("send_notification", { title, body, sessionId: session.id });
        }
      }

      // Clean up entries for removed sessions
      for (const id of Object.keys(prevStates)) {
        if (!state.sessions.find((s) => s.id === id)) {
          delete prevStates[id];
          delete lastNotifyRef.current[id];
        }
      }
    });

    return unsub;
  }, [notificationsEnabled]);
}
