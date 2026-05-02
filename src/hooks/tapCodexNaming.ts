import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { dlog } from "../lib/debugLog";
import { getResumeId } from "../lib/claude";
import {
  codexDefaultTabNameCandidates,
  deriveCodexPromptTitle,
  isAutoNameableCodexName,
} from "../lib/codexNaming";

function maybeAutoNameCodexSession(sid: string, display: string, seen: Set<string>): string | null {
  if (seen.has(sid)) return null;
  const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
  if (!session || session.config.cli !== "codex") return null;
  const defaultNames = codexDefaultTabNameCandidates(
    session.config.workingDir,
    session.config.launchWorkingDir,
  );
  if (!isAutoNameableCodexName(session.name, defaultNames)) {
    dlog("tap", sid, `codex auto-rename skipped; tab name "${session.name}" is not default`, "DEBUG", {
      event: "codex.auto_rename_skipped",
      data: {
        name: session.name,
        defaultNames,
      },
    });
    seen.add(sid);
    return null;
  }
  const title = deriveCodexPromptTitle(display);
  if (!title || title === session.name) return null;
  useSessionStore.getState().renameSession(sid, title);
  useSettingsStore.getState().setSessionName(getResumeId(session), title);
  seen.add(sid);
  return title;
}

export function createTapCodexNaming(sessionId: string) {
  let codexAutoNameTitle: string | null = null;
  const codexAutoNamed = new Set<string>();
  // Tracks Codex sessions that have already had an LLM-upgrade attempt
  // kicked off, so we never spawn a second `codex exec` for the same tab.
  const codexLLMUpgraded = new Set<string>();

  const persistSessionRegistrationName = (registeredSessionId: string | null): void => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    if (session?.config.cli === "codex" && codexAutoNameTitle && registeredSessionId) {
      useSettingsStore.getState().setSessionName(registeredSessionId, codexAutoNameTitle);
    }
  };

  const handleUserInput = (display: string): void => {
    // [SL-23] Codex LLM auto-rename upgrade: heuristic name applied
    // synchronously by maybeAutoNameCodexSession, then fire-and-forget
    // `codex exec` upgrade replaces it iff name still equals heuristic
    // (respects manual mid-flight renames). codexLLMUpgraded gate
    // prevents duplicate exec spawns. Backend: see CO-06.
    const heuristicTitle = maybeAutoNameCodexSession(sessionId, display, codexAutoNamed);
    if (!heuristicTitle) return;
    codexAutoNameTitle = heuristicTitle;
    // Provider-symmetric upgrade path: ask Codex's own model (via
    // `codex exec`) for a better title. Fire-and-forget; the
    // heuristic name is already showing, so nothing blocks the UI.
    const settings = useSettingsStore.getState();
    if (!settings.codexAutoRenameLLMEnabled || codexLLMUpgraded.has(sessionId)) return;
    codexLLMUpgraded.add(sessionId);
    invoke<string>("generate_codex_session_title", {
      prompt: display,
      model: settings.codexAutoRenameLLMModel,
    })
      .then((llmTitle) => {
        if (!llmTitle || llmTitle === heuristicTitle) return;
        // Respect manual user renames mid-flight: only upgrade if
        // the tab name is still the heuristic we set.
        const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
        if (!current || current.name !== heuristicTitle) return;
        useSessionStore.getState().renameSession(sessionId, llmTitle);
        useSettingsStore.getState().setSessionName(getResumeId(current), llmTitle);
        codexAutoNameTitle = llmTitle;
      })
      .catch((err) => dlog("tap", sessionId, `codex auto-rename LLM failed: ${err}`, "DEBUG"));
  };

  return {
    handleUserInput,
    persistSessionRegistrationName,
  };
}
