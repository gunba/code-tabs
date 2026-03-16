import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { dirToTabName } from "../lib/claude";

/**
 * Session namer — calls Haiku once per session to generate a 2-4 word title
 * from the first user message. Uses haiku_query (Rust) which hooks directly
 * into Claude.exe's stdin/stdout via piped child process (not PTY).
 *
 * Triggers when assistantMessageCount reaches 1 and the session still has
 * its default directory-based name.
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

        // Only trigger when we have at least one assistant message
        // and the session still uses the default dir name
        if (session.metadata.assistantMessageCount < 1) continue;
        const defaultName = dirToTabName(session.config.workingDir);
        if (session.name !== defaultName) {
          named.add(session.id); // Already named, skip
          continue;
        }

        // Mark as in-progress to prevent duplicate calls
        named.add(session.id);

        // Get the first user output to include in the naming prompt
        const output = (session.metadata.recentOutput || "").slice(0, 200).replace(/\n/g, " ");

        // Fire and forget — set the CLI path and query Haiku
        (async () => {
          try {
            await invoke("haiku_set_path", { path: claudePath });
            const response = await invoke<string>("haiku_query", {
              prompt: `Session in directory "${defaultName}". Recent output: "${output}". Give a 2-4 word title for this session. Return ONLY the title, nothing else.`,
              systemPrompt: "You name Claude Code sessions with short 2-4 word titles. Return only the title text, no quotes, no explanation.",
            });

            const title = response.trim().replace(/^["']|["']$/g, "").slice(0, 30);
            if (title.length >= 2) {
              useSessionStore.getState().renameSession(session.id, title);
            }
          } catch (err) {
            console.error("[useMetaAgent] Naming failed:", err);
            named.delete(session.id); // Allow retry
          }
        })();
      }
    });

    return unsub;
  }, []);

  return { isRunning: false };
}
