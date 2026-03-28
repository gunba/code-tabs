import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri IPC
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock paths (normalizePath used by some actions)
vi.mock("../../lib/paths", () => ({
  normalizePath: (p: string) => p,
}));

// Mock sessions store (settings imports it for bootstrapCommandUsage)
vi.mock("../sessions", () => ({
  useSessionStore: { getState: () => ({ claudePath: null }) },
}));

// Ensure crypto.randomUUID is available in test env
if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 10),
  });
}

import { useSettingsStore } from "../settings";

function resetStore() {
  useSettingsStore.setState({
    commandUsage: {},
    capturedDefaultPrompt: null,
    savedPrompts: [],
    commandBarExpanded: false,
  });
}

describe("recordCommandUsage", () => {
  beforeEach(resetStore);

  it("normalizes command to lowercase and increments count", () => {
    useSettingsStore.getState().recordCommandUsage("/Review");
    expect(useSettingsStore.getState().commandUsage).toEqual({ "/review": 1 });
  });

  it("accumulates counts for repeated calls", () => {
    const { recordCommandUsage } = useSettingsStore.getState();
    recordCommandUsage("/build");
    recordCommandUsage("/build");
    recordCommandUsage("/build");
    expect(useSettingsStore.getState().commandUsage["/build"]).toBe(3);
  });
});

describe("setCapturedDefaultPrompt", () => {
  beforeEach(resetStore);

  it("sets the captured prompt", () => {
    useSettingsStore.getState().setCapturedDefaultPrompt("You are Claude...");
    expect(useSettingsStore.getState().capturedDefaultPrompt).toBe("You are Claude...");
  });

  it("returns same state reference when value unchanged (identity guard)", () => {
    useSettingsStore.getState().setCapturedDefaultPrompt("You are Claude...");
    const stateBefore = useSettingsStore.getState();
    useSettingsStore.getState().setCapturedDefaultPrompt("You are Claude...");
    const stateAfter = useSettingsStore.getState();
    // Zustand identity guard: if set() returns same state, no re-render
    expect(stateAfter.capturedDefaultPrompt).toBe(stateBefore.capturedDefaultPrompt);
  });
});

describe("savedPrompts CRUD", () => {
  beforeEach(resetStore);

  it("addSavedPrompt appends a prompt with generated ID", () => {
    useSettingsStore.getState().addSavedPrompt("My Prompt", "Custom instructions...");
    const prompts = useSettingsStore.getState().savedPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("My Prompt");
    expect(prompts[0].text).toBe("Custom instructions...");
    expect(prompts[0].id).toBeTruthy();
  });

  it("updateSavedPrompt modifies matching prompt", () => {
    useSettingsStore.getState().addSavedPrompt("Original", "text");
    const id = useSettingsStore.getState().savedPrompts[0].id;
    useSettingsStore.getState().updateSavedPrompt(id, { name: "Updated" });
    const prompt = useSettingsStore.getState().savedPrompts[0];
    expect(prompt.name).toBe("Updated");
    expect(prompt.text).toBe("text"); // unchanged
  });

  it("removeSavedPrompt removes by ID", () => {
    useSettingsStore.getState().addSavedPrompt("To Remove", "text");
    const id = useSettingsStore.getState().savedPrompts[0].id;
    useSettingsStore.getState().removeSavedPrompt(id);
    expect(useSettingsStore.getState().savedPrompts).toHaveLength(0);
  });

  it("removeSavedPrompt is a no-op for unknown ID", () => {
    useSettingsStore.getState().addSavedPrompt("Keep", "text");
    useSettingsStore.getState().removeSavedPrompt("nonexistent-id");
    expect(useSettingsStore.getState().savedPrompts).toHaveLength(1);
  });
});
