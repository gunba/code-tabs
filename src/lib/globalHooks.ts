import { invoke } from "@tauri-apps/api/core";

/**
 * All Claude Code hook event names that should have no-op hooks registered
 * to trigger JSON.stringify serialization (captured by our TAP pipeline).
 */
export const RECORDING_HOOK_EVENTS = [
  "SessionEnd",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "Notification",
  "SubagentStop",
  "Elicitation",
  "ElicitationResult",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "Setup",
] as const;

// Cross-platform no-op command (Windows has no `true` binary)
const NOOP_COMMAND = 'node -e ""';

interface MatcherGroup {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

type HooksMap = Record<string, MatcherGroup[]>;

/**
 * Build the no-op hooks structure for all recording events.
 */
export function buildNoopHooks(): HooksMap {
  const hooks: HooksMap = {};
  for (const event of RECORDING_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command: NOOP_COMMAND }] }];
  }
  return hooks;
}

/**
 * Merge no-op hooks into existing hooks without overwriting user-configured hooks.
 * Only adds hooks for events where the user has no existing hooks.
 */
export function mergeNoopHooks(existing: HooksMap): HooksMap {
  const merged = { ...existing };
  for (const event of RECORDING_HOOK_EVENTS) {
    if (!merged[event] || merged[event].length === 0) {
      merged[event] = [{ hooks: [{ type: "command", command: NOOP_COMMAND }] }];
    }
  }
  return merged;
}

/**
 * Audit which recording hook events are missing from the given hooks.
 * Returns the list of event names that have no hooks configured.
 */
export function auditGlobalHooks(existing: HooksMap): string[] {
  return RECORDING_HOOK_EVENTS.filter(
    (event) => !existing[event] || existing[event].length === 0
  );
}

/**
 * Install recording hooks into user-scope settings.json.
 * Reads current hooks, merges no-op hooks for missing events, saves back.
 */
export async function installGlobalHooks(): Promise<{ installed: number; total: number }> {
  // Read current user-scope hooks
  const result = await invoke<Record<string, unknown>>("discover_hooks", { workingDirs: [] });
  const userHooks: HooksMap = (result["user"] as HooksMap) ?? {};

  const missing = auditGlobalHooks(userHooks);
  if (missing.length === 0) {
    return { installed: 0, total: RECORDING_HOOK_EVENTS.length };
  }

  const merged = mergeNoopHooks(userHooks);
  await invoke("save_hooks", {
    scope: "user",
    workingDir: "",
    hooksJson: JSON.stringify(merged),
  });

  return { installed: missing.length, total: RECORDING_HOOK_EVENTS.length };
}
