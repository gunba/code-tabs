import { getRecordingConfigForCliFromState, useSettingsStore } from "../store/settings";
import type { CliKind } from "../types/session";

/** Cached sets of noisy event kinds, rebuilt when config changes. */
let cachedByCli: Record<CliKind, ReadonlySet<string>> = {
  claude: new Set(getRecordingConfigForCliFromState(useSettingsStore.getState(), "claude").noisyEventKinds),
  codex: new Set(getRecordingConfigForCliFromState(useSettingsStore.getState(), "codex").noisyEventKinds),
};

useSettingsStore.subscribe((state, prev) => {
  const claudeKinds = getRecordingConfigForCliFromState(state, "claude").noisyEventKinds;
  const codexKinds = getRecordingConfigForCliFromState(state, "codex").noisyEventKinds;
  const prevClaudeKinds = getRecordingConfigForCliFromState(prev, "claude").noisyEventKinds;
  const prevCodexKinds = getRecordingConfigForCliFromState(prev, "codex").noisyEventKinds;
  if (claudeKinds === prevClaudeKinds && codexKinds === prevCodexKinds) return;
  cachedByCli = {
    claude: new Set(claudeKinds),
    codex: new Set(codexKinds),
  };
});

/** Returns the current set of noisy event kinds (synchronous, cached). */
export function getNoisyEventKinds(cli: CliKind = "claude"): ReadonlySet<string> {
  return cachedByCli[cli] ?? cachedByCli.claude;
}
