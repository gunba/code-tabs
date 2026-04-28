import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tapEventBus } from "../../lib/tapEventBus";
import type { CapturedMessage, CliKind } from "../../types/session";

/**
 * Live Codex sessions read their conversation directly from the rollout file
 * on demand. Refreshes whenever a turn boundary fires.
 */
export function useCodexMessages(sessionId: string, cli: CliKind): CapturedMessage[] | null {
  const [messages, setMessages] = useState<CapturedMessage[] | null>(null);

  const refresh = useCallback(() => {
    if (cli !== "codex") return;
    invoke<CapturedMessage[]>("read_codex_session_messages", { sessionId })
      .then((next) => setMessages(next))
      .catch(() => setMessages([]));
  }, [sessionId, cli]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (cli !== "codex") return;
    return tapEventBus.subscribe(sessionId, (event) => {
      if (event.kind === "CodexTaskComplete" || event.kind === "UserInterruption") {
        refresh();
      }
    });
  }, [sessionId, cli, refresh]);

  return messages;
}
