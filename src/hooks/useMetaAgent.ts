import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { dirToTabName } from "../lib/claude";

/**
 * Session namer + summariser — calls Haiku once per session to generate
 * a 2-4 word title and a brief summary from the first user message.
 *
 * For new sessions: triggers when assistantMessageCount reaches 1.
 * For revived sessions: reads the first user message from the JSONL history.
 *
 * Uses haiku_query (Rust) which hooks directly into Claude.exe's
 * stdin/stdout via piped child process (not PTY).
 */
export function useMetaAgent(): { isRunning: boolean } {
  const namedRef = useRef(new Set<string>());

  useEffect(() => {
    const named = namedRef.current;

    const unsub = useSessionStore.subscribe((state) => {
      const claudePath = state.claudePath;
      if (!claudePath) return;

      for (const session of state.sessions) {
        if (session.isMetaAgent || session.state === "dead") continue;
        if (named.has(session.id)) continue;

        // Need at least one assistant message (proves session is active)
        if (session.metadata.assistantMessageCount < 1) continue;

        // Already named? Skip.
        const defaultName = dirToTabName(session.config.workingDir);
        if (session.name !== defaultName) {
          named.add(session.id);
          continue;
        }

        // Mark in-progress
        named.add(session.id);

        const sessionId = session.id;
        const workingDir = session.config.workingDir;
        // For resumed sessions, the JSONL is under the original session ID
        const jsonlId = session.config.resumeSession || session.config.sessionId || session.id;

        (async () => {
          try {
            // Get the first user message from the JSONL file
            let firstMessage: string;
            try {
              firstMessage = await invoke<string>("get_first_user_message", {
                sessionId: jsonlId,
                workingDir,
              });
            } catch {
              // Fallback to recentOutput if JSONL not available
              firstMessage = (session.metadata.recentOutput || "").slice(0, 300);
            }

            if (!firstMessage || firstMessage.length < 5) {
              named.delete(sessionId);
              return;
            }

            await invoke("haiku_set_path", { path: claudePath });
            const response = await invoke<string>("haiku_query", {
              prompt: `First user message in a Claude Code session: "${firstMessage.slice(0, 300)}"\n\nRespond with EXACTLY two lines:\nLine 1: A 2-4 word title\nLine 2: A one-sentence summary`,
              systemPrompt: "You name and summarize Claude Code sessions. Respond with exactly two lines: the title on line 1, the summary on line 2. No quotes, no labels, no extra text.",
            });

            const lines = response.trim().split("\n").map(l => l.trim()).filter(Boolean);
            const title = (lines[0] || "").replace(/^["']|["']$/g, "").slice(0, 30);
            const summary = (lines[1] || lines[0] || "").slice(0, 200);

            if (title.length >= 2) {
              useSessionStore.getState().renameSession(sessionId, title);
            }
            if (summary.length >= 5) {
              useSessionStore.getState().updateMetadata(sessionId, { nodeSummary: summary });
            }
          } catch (err) {
            console.error("[useMetaAgent] Naming failed:", err);
            named.delete(sessionId);
          }
        })();
      }
    });

    return unsub;
  }, []);

  return { isRunning: false };
}
