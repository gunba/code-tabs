import type { SessionConfig } from "../types/session";
import { DEFAULT_SESSION_CONFIG } from "../types/session";
import { normalizePath, parseWorktreePath } from "./paths";

export function workspaceDefaultsKey(workingDir: string): string {
  const wt = parseWorktreePath(workingDir);
  return normalizePath(wt ? wt.projectRoot : workingDir).toLowerCase();
}

/** One-shot migration for Codex sessions saved before the Codex-native
 *  Sandbox + Approval dropdowns existed. Translates the legacy Claude-shaped
 *  permissionMode into the new Codex axes and clears permissionMode so the
 *  next launch reads from the new fields. Idempotent: no-op when either
 *  Codex field is already set, or when cli is not "codex". */
function migrateCodexPerms(cfg: SessionConfig): SessionConfig {
  if (cfg.cli !== "codex") return cfg;
  if (cfg.codexSandboxMode != null || cfg.codexApprovalPolicy != null) return cfg;

  const next = { ...cfg };
  switch (cfg.permissionMode) {
    case "planMode":
      next.codexSandboxMode = "read-only";
      next.codexApprovalPolicy = "untrusted";
      next.permissionMode = "default";
      break;
    case "acceptEdits":
    case "dontAsk":
      next.codexSandboxMode = "workspace-write";
      next.codexApprovalPolicy = "never";
      next.permissionMode = "default";
      break;
    case "bypassPermissions":
      next.dangerouslySkipPermissions = true;
      next.permissionMode = "default";
      break;
    case "auto":
      // Codex schema marks `on-failure` (the half of --full-auto we'd
      // re-emit) as DEPRECATED. Land on Codex defaults and let the user
      // pick explicitly from the dropdowns.
      next.permissionMode = "default";
      break;
    case "default":
    default:
      // Nothing to migrate.
      break;
  }
  return next;
}

export function buildInitialLauncherConfig(params: {
  lastConfig: SessionConfig;
  savedDefaults: SessionConfig | null;
  workspaceDefaults: Record<string, Partial<SessionConfig>>;
}): SessionConfig {
  const resumeLaunch = !!params.lastConfig.resumeSession;
  const defaults = resumeLaunch
    ? params.lastConfig
    : (params.savedDefaults ?? params.lastConfig);
  const wsKey = workspaceDefaultsKey(defaults.workingDir);
  const wsDefaults = !resumeLaunch && wsKey
    ? params.workspaceDefaults[wsKey]
    : undefined;

  const merged: SessionConfig = {
    ...DEFAULT_SESSION_CONFIG,
    ...defaults,
    ...(wsDefaults ?? {}),
    workingDir: defaults.workingDir,
    continueSession: false,
    sessionId: null,
    runMode: false,
    forkSession: false,
  };

  return migrateCodexPerms(merged);
}
