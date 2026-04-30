import { invoke } from "@tauri-apps/api/core";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { canResumeSession, getResumeId, stripWorktreeFlags } from "../../lib/claude";
import { dlog } from "../../lib/debugLog";
import {
  unregisterInspectorPort,
} from "../../lib/inspectorPort";
import {
  unregisterPtyHandleId,
  unregisterPtyKill,
  unregisterPtyWriter,
} from "../../lib/ptyRegistry";
import { useSessionStore } from "../../store/sessions";
import type { Session, SessionConfig } from "../../types/session";

interface UseSessionRespawnParams {
  inspectorDisconnect: () => void;
  ptyCleanup: () => void;
  resetSessionInUseDetection: () => void;
  session: Session;
  setExternalHolder: (holder: number[] | null) => void;
  setInspectorPort: Dispatch<SetStateAction<number | null>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRespawnCounter: Dispatch<SetStateAction<number>>;
}

// [RS-01] [PT-11] triggerRespawn: cleanup old PTY/watchers/inspector, allocate port, increment respawnCounter
export function useSessionRespawn({
  inspectorDisconnect,
  ptyCleanup,
  resetSessionInUseDetection,
  session,
  setExternalHolder,
  setInspectorPort,
  setLoading,
  setRespawnCounter,
}: UseSessionRespawnParams): (config?: SessionConfig, name?: string) => void {
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const renameSession = useSessionStore((s) => s.renameSession);
  const updateState = useSessionStore((s) => s.updateState);

  return useCallback(
    (config?: SessionConfig, name?: string) => {
      dlog("terminal", session.id, "respawn triggered", "LOG", {
        event: "session.respawn_triggered",
        data: {
          name: name ?? null,
          requestedConfig: config ?? null,
        },
      });
      // 1. Clean up old PTY, watchers, inspector, and tap server
      ptyCleanup();
      inspectorDisconnect();
      invoke("stop_tap_server", { sessionId: session.id }).catch(() => {});
      invoke("stop_codex_rollout", { sessionId: session.id }).catch(() => {});
      unregisterPtyWriter(session.id);
      unregisterPtyKill(session.id);
      unregisterPtyHandleId(session.id);
      unregisterInspectorPort(session.id);
      useSessionStore.getState().setInspectorOff(session.id, false);

      // 2. Determine config (default: resume if conversation exists)
      const canResume = canResumeSession(session);
      const newConfig: SessionConfig = config ?? {
        ...session.config,
        resumeSession: canResume ? getResumeId(session) : null,
        forkSession: false,
        continueSession: false,
        extraFlags: stripWorktreeFlags(session.config.extraFlags),
      };

      // 3. Update session in store
      updateConfig(session.id, newConfig);
      if (name) renameSession(session.id, name);

      setLoading(!!newConfig.resumeSession);

      // 5. Reset internal state (inspector port allocated in doSpawn)
      resetSessionInUseDetection();
      setExternalHolder(null);
      setInspectorPort(null);

      // 6. Trigger re-spawn
      updateState(session.id, "starting");
      setRespawnCounter((c) => c + 1);
    },
    [
      inspectorDisconnect,
      ptyCleanup,
      renameSession,
      resetSessionInUseDetection,
      session,
      setExternalHolder,
      setInspectorPort,
      setLoading,
      setRespawnCounter,
      updateConfig,
      updateState,
    ]
  );
}
