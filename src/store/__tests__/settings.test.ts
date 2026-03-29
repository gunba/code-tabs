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
    observedPrompts: [],
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

describe("addObservedPrompt", () => {
  beforeEach(resetStore);

  it("adds an observed prompt with generated id, label, and timestamp", () => {
    useSettingsStore.getState().addObservedPrompt("You are Claude, a helpful assistant.", "claude-opus-4-6");
    const observed = useSettingsStore.getState().observedPrompts;
    expect(observed).toHaveLength(1);
    expect(observed[0].text).toBe("You are Claude, a helpful assistant.");
    expect(observed[0].model).toBe("claude-opus-4-6");
    expect(observed[0].id).toBeTruthy();
    expect(observed[0].label).toBeTruthy();
    expect(observed[0].firstSeenAt).toBeGreaterThan(0);
  });

  it("deduplicates by exact text content (identity guard)", () => {
    const store = useSettingsStore.getState();
    store.addObservedPrompt("Same prompt", "opus");
    const stateBefore = useSettingsStore.getState();
    useSettingsStore.getState().addObservedPrompt("Same prompt", "opus");
    const stateAfter = useSettingsStore.getState();
    expect(stateAfter.observedPrompts).toHaveLength(1);
    expect(stateAfter).toBe(stateBefore);
  });

  it("deduplicates even when model differs (text is the key)", () => {
    useSettingsStore.getState().addObservedPrompt("Same prompt", "opus");
    useSettingsStore.getState().addObservedPrompt("Same prompt", "sonnet");
    expect(useSettingsStore.getState().observedPrompts).toHaveLength(1);
  });

  it("adds distinct texts as separate entries", () => {
    useSettingsStore.getState().addObservedPrompt("Prompt A", "opus");
    useSettingsStore.getState().addObservedPrompt("Prompt B", "sonnet");
    expect(useSettingsStore.getState().observedPrompts).toHaveLength(2);
  });

  it("generates label truncated at 60 chars with ellipsis", () => {
    useSettingsStore.getState().addObservedPrompt("A".repeat(80), "opus");
    expect(useSettingsStore.getState().observedPrompts[0].label).toBe("A".repeat(60) + "...");
  });

  it("generates label without ellipsis for short text", () => {
    useSettingsStore.getState().addObservedPrompt("Short text", "opus");
    expect(useSettingsStore.getState().observedPrompts[0].label).toBe("Short text");
  });

  it("caps at 50 entries with FIFO eviction", () => {
    for (let i = 0; i < 55; i++) {
      useSettingsStore.getState().addObservedPrompt(`Prompt ${i}`, "opus");
    }
    const observed = useSettingsStore.getState().observedPrompts;
    expect(observed).toHaveLength(50);
    expect(observed[0].text).toBe("Prompt 5");
    expect(observed[49].text).toBe("Prompt 54");
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

describe("setTerminalFont", () => {
  beforeEach(resetStore);

  it("updates terminalFont state", () => {
    useSettingsStore.getState().setTerminalFont("pragmasevka");
    expect(useSettingsStore.getState().terminalFont).toBe("pragmasevka");
  });

  it("resets to default", () => {
    useSettingsStore.getState().setTerminalFont("pragmasevka");
    useSettingsStore.getState().setTerminalFont("default");
    expect(useSettingsStore.getState().terminalFont).toBe("default");
  });
});
