import { getRecordingConfigForCliFromState, useSettingsStore } from "../store/settings";
import type { CliKind } from "../types/session";

/** Cached sets of noisy event kinds, rebuilt when config changes. */
let cachedByCli: Record<CliKind, ReadonlySet<string>> = {
  claude: new Set(getRecordingConfigForCliFromState(useSettingsStore.getState(), "claude").noisyEventKinds),
  codex: new Set(getRecordingConfigForCliFromState(useSettingsStore.getState(), "codex").noisyEventKinds),
};

useSettingsStore.subscribe((state, prev) => {
  if (state.recordingConfigsByCli !== prev.recordingConfigsByCli || state.recordingConfig !== prev.recordingConfig) {
    cachedByCli = {
      claude: new Set(getRecordingConfigForCliFromState(state, "claude").noisyEventKinds),
      codex: new Set(getRecordingConfigForCliFromState(state, "codex").noisyEventKinds),
    };
  }
});

/** Returns the current set of noisy event kinds (synchronous, cached). */
export function getNoisyEventKinds(cli: CliKind = "claude"): ReadonlySet<string> {
  return cachedByCli[cli] ?? cachedByCli.claude;
}
