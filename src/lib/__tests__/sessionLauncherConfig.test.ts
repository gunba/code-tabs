import { describe, expect, it } from "vitest";
import { buildInitialLauncherConfig } from "../sessionLauncherConfig";
import { DEFAULT_SESSION_CONFIG, type SessionConfig } from "../../types/session";

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    ...DEFAULT_SESSION_CONFIG,
    workingDir: "/projects/myapp",
    ...overrides,
  };
}

describe("buildInitialLauncherConfig", () => {
  it("does not apply workspace defaults when opening a resume config", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({
        cli: "codex",
        model: "gpt-5.5",
        effort: "high",
        dangerouslySkipPermissions: false,
        resumeSession: "019dc57d-b78a-75c3-b087-32d7446ebe85",
      }),
      savedDefaults: null,
      workspaceDefaults: {
        "/projects/myapp": {
          cli: "claude",
          model: "sonnet",
          effort: "max",
          dangerouslySkipPermissions: true,
        },
      },
    });

    expect(result.cli).toBe("codex");
    expect(result.model).toBe("gpt-5.5");
    expect(result.effort).toBe("high");
    expect(result.dangerouslySkipPermissions).toBe(false);
    expect(result.resumeSession).toBe("019dc57d-b78a-75c3-b087-32d7446ebe85");
  });

  it("applies workspace defaults for fresh launches", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({ cli: "claude", model: "sonnet", resumeSession: null }),
      savedDefaults: null,
      workspaceDefaults: {
        "/projects/myapp": {
          cli: "codex",
          model: "gpt-5.5",
          effort: "medium",
        },
      },
    });

    expect(result.cli).toBe("codex");
    expect(result.model).toBe("gpt-5.5");
    expect(result.effort).toBe("medium");
  });

  it("clears one-shot launch fields on initialization", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({
        continueSession: true,
        sessionId: "sid",
        runMode: true,
        forkSession: true,
      }),
      savedDefaults: null,
      workspaceDefaults: {},
    });

    expect(result.continueSession).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.runMode).toBe(false);
    expect(result.forkSession).toBe(false);
  });

  it("defaults Codex sandbox/approval to null on a fresh config", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({ cli: "claude" }),
      savedDefaults: null,
      workspaceDefaults: {},
    });

    expect(result.codexSandboxMode).toBeNull();
    expect(result.codexApprovalPolicy).toBeNull();
  });

  it("migrates legacy Codex permissionMode=planMode to read-only + untrusted", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({
        cli: "codex",
        permissionMode: "planMode",
        codexSandboxMode: null,
        codexApprovalPolicy: null,
      }),
      savedDefaults: null,
      workspaceDefaults: {},
    });

    expect(result.codexSandboxMode).toBe("read-only");
    expect(result.codexApprovalPolicy).toBe("untrusted");
    // permissionMode reset so we don't re-migrate next time and so the
    // Claude pill row (if the user switches CLI) starts clean.
    expect(result.permissionMode).toBe("default");
  });

  it("migrates legacy Codex permissionMode=acceptEdits to workspace-write + never", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({
        cli: "codex",
        permissionMode: "acceptEdits",
        codexSandboxMode: null,
        codexApprovalPolicy: null,
      }),
      savedDefaults: null,
      workspaceDefaults: {},
    });

    expect(result.codexSandboxMode).toBe("workspace-write");
    expect(result.codexApprovalPolicy).toBe("never");
    expect(result.permissionMode).toBe("default");
  });

  it("migrates legacy Codex permissionMode=bypassPermissions to dangerouslySkipPermissions", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({
        cli: "codex",
        permissionMode: "bypassPermissions",
        codexSandboxMode: null,
        codexApprovalPolicy: null,
      }),
      savedDefaults: null,
      workspaceDefaults: {},
    });

    expect(result.dangerouslySkipPermissions).toBe(true);
    expect(result.codexSandboxMode).toBeNull();
    expect(result.codexApprovalPolicy).toBeNull();
    expect(result.permissionMode).toBe("default");
  });

  it("does not re-migrate when Codex fields are already set", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({
        cli: "codex",
        permissionMode: "planMode", // would otherwise migrate to read-only/untrusted
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
      }),
      savedDefaults: null,
      workspaceDefaults: {},
    });

    expect(result.codexSandboxMode).toBe("workspace-write");
    expect(result.codexApprovalPolicy).toBe("on-request");
    // permissionMode passes through untouched in the no-op path.
    expect(result.permissionMode).toBe("planMode");
  });

  it("does not migrate when cli is claude", () => {
    const result = buildInitialLauncherConfig({
      lastConfig: config({
        cli: "claude",
        permissionMode: "planMode",
      }),
      savedDefaults: null,
      workspaceDefaults: {},
    });

    expect(result.permissionMode).toBe("planMode");
    expect(result.codexSandboxMode).toBeNull();
    expect(result.codexApprovalPolicy).toBeNull();
  });
});
