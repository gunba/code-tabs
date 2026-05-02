import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { DEFAULT_SESSION_CONFIG, type Session } from "../../types/session";
import { createTapCodexNaming } from "../tapCodexNaming";

const mockInvoke = vi.mocked(invoke);

function makeCodexSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-session",
    name: "ato-mcp",
    config: {
      ...DEFAULT_SESSION_CONFIG,
      cli: "codex",
      workingDir: "/home/jordan/Desktop/Projects/ato-mcp",
      launchWorkingDir: "/home/jordan/Desktop",
      sessionId: "codex-session",
    },
    state: "idle",
    metadata: {} as Session["metadata"],
    createdAt: "2026-05-02T00:00:00.000Z",
    lastActive: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

function sessionName(): string | undefined {
  return useSessionStore.getState().sessions.find((session) => session.id === "app-session")?.name;
}

beforeEach(() => {
  mockInvoke.mockReset();
  useSessionStore.setState({
    sessions: [makeCodexSession()],
    activeTabId: "app-session",
  });
  useSettingsStore.setState({
    codexAutoRenameLLMEnabled: true,
    codexAutoRenameLLMModel: "gpt-5-mini",
    sessionNames: {},
  });
});

describe("createTapCodexNaming", () => {
  it("renames a workingDir-default Codex tab even when launchWorkingDir is stale and upgrades via LLM", async () => {
    let resolveTitle!: (title: string) => void;
    mockInvoke.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveTitle = resolve;
    }));

    const naming = createTapCodexNaming("app-session");
    naming.handleUserInput("Fix the Codex tab renaming bug in settings");

    expect(sessionName()).toBe("Fix the Codex tab renaming bug in");
    expect(useSettingsStore.getState().sessionNames["codex-session"]).toBe(
      "Fix the Codex tab renaming bug in",
    );
    expect(mockInvoke).toHaveBeenCalledWith("generate_codex_session_title", {
      prompt: "Fix the Codex tab renaming bug in settings",
      model: "gpt-5-mini",
    });

    resolveTitle("Codex Rename Investigation");
    await Promise.resolve();

    expect(sessionName()).toBe("Codex Rename Investigation");
    expect(useSettingsStore.getState().sessionNames["codex-session"]).toBe(
      "Codex Rename Investigation",
    );
  });

  it("does not apply the LLM title after a manual rename replaces the heuristic title", async () => {
    let resolveTitle!: (title: string) => void;
    mockInvoke.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveTitle = resolve;
    }));

    const naming = createTapCodexNaming("app-session");
    naming.handleUserInput("Fix the Codex tab renaming bug in settings");
    useSessionStore.getState().renameSession("app-session", "Manual title");

    resolveTitle("Codex Rename Investigation");
    await Promise.resolve();

    expect(sessionName()).toBe("Manual title");
  });
});
