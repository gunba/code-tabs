import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useInspectorConnection } from "../../hooks/useInspectorConnection";
import { registerInspectorCallbacks, unregisterInspectorCallbacks } from "../../lib/inspectorPort";
import { useSettingsStore } from "../../store/settings";
import type { Session } from "../../types/session";

interface TerminalInspector {
  inspector: ReturnType<typeof useInspectorConnection>;
  loading: boolean;
  setInspectorPort: Dispatch<SetStateAction<number | null>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}

export function useTerminalInspector(session: Session): TerminalInspector {
  const [inspectorReconnectKey, setInspectorReconnectKey] = useState(0);
  const [inspectorPort, setInspectorPort] = useState<number | null>(null);
  const [loading, setLoading] = useState(!!session.config.resumeSession);
  const inspector = useInspectorConnection(
    session.state !== "dead" && session.config.cli === "claude" ? session.id : null,
    inspectorPort,
    inspectorReconnectKey
  );

  // Register inspector disconnect/reconnect callbacks for external debugger support
  useEffect(() => {
    registerInspectorCallbacks(session.id, {
      disconnect: inspector.disconnect,
      reconnect: () => setInspectorReconnectKey((k) => k + 1),
    });
    return () => unregisterInspectorCallbacks(session.id);
  }, [session.id, inspector.disconnect]);

  // [SR-01] Hide loading spinner once the session signals readiness.
  // Claude: inspector connect (~1s after spawn).
  // Codex: no inspector - first state transition off "starting" (set after pty.spawn).
  useEffect(() => {
    if (!loading) return;
    if (session.config.cli === "codex") {
      if (session.state !== "starting") setLoading(false);
    } else if (inspector.connected) {
      setLoading(false);
    }
  }, [loading, inspector.connected, session.config.cli, session.state]);

  // [SL-07] Cache session config when inspector connects (for resume picker fallback)
  useEffect(() => {
    if (inspector.connected && session.config.sessionId) {
      useSettingsStore.getState().cacheSessionConfig(session.config.sessionId, session.config);
    }
  }, [inspector.connected, session.id, session.config.sessionId]);

  return {
    inspector,
    loading,
    setInspectorPort,
    setLoading,
  };
}
