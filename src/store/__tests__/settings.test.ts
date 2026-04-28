import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Tauri IPC
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock paths (normalizePath used by some actions)
vi.mock("../../lib/paths", () => ({
  normalizePath: (p: string) => p,
  parseWorktreePath: (dir: string) => {
    const normalized = dir.replace(/\\/g, "/");
    const match = normalized.match(/^(.+)\/\.(?:code_tabs|claude)\/worktrees\/([^/]+)\/?$/);
    if (!match) return null;
    return { projectRoot: match[1], worktreeName: match[2], projectName: match[1].split("/").pop() };
  },
}));

// Mock sessions store (settings imports it for bootstrapCommandUsage)
vi.mock("../sessions", () => ({
  useSessionStore: { getState: () => ({ claudePath: null, codexPath: null }) },
}));

// Ensure crypto.randomUUID is available in test env
if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 10),
  });
}

import { DEFAULT_RECORDING_CONFIG, DEFAULT_RECORDING_CONFIGS_BY_CLI, useSettingsStore } from "../settings";

function resetStore() {
  useSettingsStore.setState({
    commandUsage: {},
    observedPrompts: [],
    savedPrompts: [],
    commandBarExpanded: false,
    systemPromptRules: [],
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

describe("recording defaults", () => {
  it("starts debug observability in quiet mode", () => {
    expect(DEFAULT_RECORDING_CONFIG.taps.enabled).toBe(false);
    expect(DEFAULT_RECORDING_CONFIG.traffic.enabled).toBe(false);
    expect(DEFAULT_RECORDING_CONFIG.debugCapture).toBe(false);
    expect(DEFAULT_RECORDING_CONFIG.taps.categories.parse).toBe(true);
    expect(DEFAULT_RECORDING_CONFIG.taps.categories.stringify).toBe(true);
    expect(DEFAULT_RECORDING_CONFIG.taps.categories.envproxy).toBe(false);
    expect(DEFAULT_RECORDING_CONFIG.taps.categories.console).toBe(false);
    expect(DEFAULT_RECORDING_CONFIGS_BY_CLI.codex.noisyEventKinds).toContain("CodexTokenCount");
  });
});

describe("per-CLI discovery state", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      cliVersions: { claude: null, codex: null },
      lastOpenedCliVersions: { claude: null, codex: null },
      previousCliVersions: { claude: null, codex: null },
      cliVersion: null,
      previousCliVersion: null,
      cliCapabilitiesByCli: {
        claude: { models: [], permissionModes: [], flags: [], options: [], commands: [] },
        codex: { models: [], permissionModes: [], flags: [], options: [], commands: [] },
      },
      cliCapabilities: { models: [], permissionModes: [], flags: [], options: [], commands: [] },
      slashCommandsByCli: { claude: [], codex: [] },
      slashCommands: [],
    });
  });

  it("stores capabilities per CLI while mirroring Claude into legacy fields", () => {
    const claudeCaps = { models: ["sonnet"], permissionModes: [], flags: ["--model"], options: [], commands: [] };
    const codexCaps = { models: ["gpt-5.1-codex"], permissionModes: [], flags: ["--cd"], options: [], commands: [] };

    useSettingsStore.getState().setCliCapabilitiesForCli("claude", "claude-1", claudeCaps);
    useSettingsStore.getState().setCliCapabilitiesForCli("codex", "codex-1", codexCaps);

    const state = useSettingsStore.getState();
    expect(state.cliVersions).toEqual({ claude: "claude-1", codex: "codex-1" });
    expect(state.cliCapabilitiesByCli.claude).toEqual(claudeCaps);
    expect(state.cliCapabilitiesByCli.codex).toEqual(codexCaps);
    expect(state.cliVersion).toBe("claude-1");
    expect(state.cliCapabilities).toEqual(claudeCaps);
  });

  it("keeps slash commands separated by CLI and maintains a merged legacy list", () => {
    useSettingsStore.getState().setSlashCommandsForCli("claude", [{ cmd: "/doctor", desc: "Claude diagnostic" }]);
    useSettingsStore.getState().setSlashCommandsForCli("codex", [{ cmd: "/init", desc: "Codex instructions" }]);

    const state = useSettingsStore.getState();
    expect(state.slashCommandsByCli.claude.map((c) => c.cmd)).toEqual(["/doctor"]);
    expect(state.slashCommandsByCli.codex.map((c) => c.cmd)).toEqual(["/init"]);
    expect(state.slashCommands.map((c) => c.cmd)).toEqual(["/doctor", "/init"]);
  });

  it("tracks the last app-opened version per CLI", () => {
    useSettingsStore.getState().setLastOpenedCliVersion("claude", "2.1.119");
    useSettingsStore.getState().setLastOpenedCliVersion("codex", "0.125.0");

    expect(useSettingsStore.getState().lastOpenedCliVersions).toEqual({
      claude: "2.1.119",
      codex: "0.125.0",
    });
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
    expect(observed[0].cli).toBe("claude");
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

  it("keeps identical observed prompt text separate per CLI", () => {
    useSettingsStore.getState().addObservedPrompt("Same prompt", "opus", "claude");
    useSettingsStore.getState().addObservedPrompt("Same prompt", "gpt-5.2", "codex");
    const observed = useSettingsStore.getState().observedPrompts;
    expect(observed).toHaveLength(2);
    expect(observed.map((p) => p.cli)).toEqual(["claude", "codex"]);
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

describe("loadKnownEnvVars", () => {
  beforeEach(() => {
    useSettingsStore.setState({ knownEnvVars: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sets knownEnvVars from invoke result", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockVars = [
      { name: "ANTHROPIC_API_KEY", description: "API key", category: "api", documented: true },
      { name: "HTTP_PROXY", description: "Proxy", category: "network", documented: true },
    ];
    vi.mocked(invoke).mockResolvedValueOnce(mockVars);

    await useSettingsStore.getState().loadKnownEnvVars(null);

    expect(useSettingsStore.getState().knownEnvVars).toEqual(mockVars);
  });

  it("leaves knownEnvVars empty when invoke throws", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("binary not found"));

    await useSettingsStore.getState().loadKnownEnvVars(null);

    expect(useSettingsStore.getState().knownEnvVars).toEqual([]);
  });

  it("falls back to session store claudePath when cliPath is undefined", async () => {
    // Module mock returns claudePath: null from session store
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce([]);

    await useSettingsStore.getState().loadKnownEnvVars(); // no args → reads session store

    expect(invoke).toHaveBeenCalledWith("discover_env_vars", { cliPath: null });
  });
});

describe("systemPromptRules CRUD", () => {
  beforeEach(resetStore);

  it("addSystemPromptRule appends a rule with defaults", () => {
    useSettingsStore.getState().addSystemPromptRule();
    const rules = useSettingsStore.getState().systemPromptRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("New Rule");
    expect(rules[0].pattern).toBe("");
    expect(rules[0].replacement).toBe("");
    expect(rules[0].flags).toBe("g");
    expect(rules[0].enabled).toBe(true);
    expect(rules[0].id).toBeTruthy();
  });

  it("updateSystemPromptRule modifies matching rule", () => {
    useSettingsStore.getState().addSystemPromptRule();
    const id = useSettingsStore.getState().systemPromptRules[0].id;
    useSettingsStore.getState().updateSystemPromptRule(id, { pattern: "Claude", replacement: "Assistant" });
    const rule = useSettingsStore.getState().systemPromptRules[0];
    expect(rule.pattern).toBe("Claude");
    expect(rule.replacement).toBe("Assistant");
    expect(rule.name).toBe("New Rule"); // unchanged
  });

  it("removeSystemPromptRule removes by ID", () => {
    useSettingsStore.getState().addSystemPromptRule();
    const id = useSettingsStore.getState().systemPromptRules[0].id;
    useSettingsStore.getState().removeSystemPromptRule(id);
    expect(useSettingsStore.getState().systemPromptRules).toHaveLength(0);
  });

  it("removeSystemPromptRule is a no-op for unknown ID", () => {
    useSettingsStore.getState().addSystemPromptRule();
    useSettingsStore.getState().removeSystemPromptRule("nonexistent");
    expect(useSettingsStore.getState().systemPromptRules).toHaveLength(1);
  });

  it("reorderSystemPromptRules swaps adjacent rules", () => {
    useSettingsStore.getState().addSystemPromptRule();
    useSettingsStore.getState().addSystemPromptRule();
    const rules = useSettingsStore.getState().systemPromptRules;
    const firstId = rules[0].id;
    const secondId = rules[1].id;
    // Move second rule up (direction = -1)
    useSettingsStore.getState().reorderSystemPromptRules(secondId, -1);
    const reordered = useSettingsStore.getState().systemPromptRules;
    expect(reordered[0].id).toBe(secondId);
    expect(reordered[1].id).toBe(firstId);
  });

  it("reorderSystemPromptRules is a no-op at boundaries", () => {
    useSettingsStore.getState().addSystemPromptRule();
    const id = useSettingsStore.getState().systemPromptRules[0].id;
    // Move first rule up (impossible)
    useSettingsStore.getState().reorderSystemPromptRules(id, -1);
    expect(useSettingsStore.getState().systemPromptRules[0].id).toBe(id);
    // Move first (and only) rule down (impossible)
    useSettingsStore.getState().reorderSystemPromptRules(id, 1);
    expect(useSettingsStore.getState().systemPromptRules[0].id).toBe(id);
  });
});

describe("setSavedDefaults with workspaceDefaults", () => {
  beforeEach(() => {
    useSettingsStore.setState({ savedDefaults: null, workspaceDefaults: {} });
  });

  const makeConfig = (overrides: Record<string, unknown> = {}) => ({
    workingDir: "/projects/myapp",
    model: "claude-sonnet-4-20250514",
    permissionMode: "default" as const,
    codexSandboxMode: null,
    codexApprovalPolicy: null,
    dangerouslySkipPermissions: false,
    systemPrompt: null,
    appendSystemPrompt: null,
    allowedTools: [] as string[],
    disallowedTools: [] as string[],
    additionalDirs: [] as string[],
    mcpConfig: null,
    agent: null,
    effort: "high",
    verbose: false,
    debug: false,
    maxBudget: null,
    resumeSession: null,
    forkSession: false,
    continueSession: false,
    projectDir: false,
    extraFlags: null,
    sessionId: null,
    runMode: false,
    providerId: null,
    cli: "claude" as const,
    ...overrides,
  });

  it("populates workspaceDefaults keyed by lowercased workingDir", () => {
    useSettingsStore.getState().setSavedDefaults(makeConfig());
    const ws = useSettingsStore.getState().workspaceDefaults;
    expect(ws["/projects/myapp"]).toBeDefined();
    expect(ws["/projects/myapp"].model).toBe("claude-sonnet-4-20250514");
    expect(ws["/projects/myapp"].effort).toBe("high");
  });

  it("stores workspace-specific defaults without workingDir or transient fields", () => {
    useSettingsStore.getState().setSavedDefaults(makeConfig({
      resumeSession: "abc",
      continueSession: true,
      sessionId: "sid-1",
      runMode: true,
      forkSession: true,
    }));
    const entry = useSettingsStore.getState().workspaceDefaults["/projects/myapp"];
    expect(entry).toBeDefined();
    expect("workingDir" in entry).toBe(false);
    expect("resumeSession" in entry).toBe(false);
    expect("continueSession" in entry).toBe(false);
    expect("sessionId" in entry).toBe(false);
    expect("runMode" in entry).toBe(false);
    expect("forkSession" in entry).toBe(false);
  });

  it("collapses worktree paths to project root for workspace key", () => {
    const wtConfig = makeConfig({
      workingDir: "/projects/myapp/.claude/worktrees/sorted-dove",
      model: "claude-opus-4-20250514",
    });
    useSettingsStore.getState().setSavedDefaults(wtConfig);
    const ws = useSettingsStore.getState().workspaceDefaults;
    // Key should be the project root, not the worktree path
    expect(ws["/projects/myapp"]).toBeDefined();
    expect(ws["/projects/myapp"].model).toBe("claude-opus-4-20250514");
  });

  it("collapses code-tabs worktree paths to project root for workspace key", () => {
    const wtConfig = makeConfig({
      workingDir: "/projects/myapp/.code_tabs/worktrees/sorted-dove",
      model: "gpt-5.1-codex",
    });
    useSettingsStore.getState().setSavedDefaults(wtConfig);
    const ws = useSettingsStore.getState().workspaceDefaults;
    expect(ws["/projects/myapp"]).toBeDefined();
    expect(ws["/projects/myapp"].model).toBe("gpt-5.1-codex");
  });

  it("different worktree paths for same project share the workspace key", () => {
    useSettingsStore.getState().setSavedDefaults(makeConfig({
      workingDir: "/projects/myapp/.claude/worktrees/wt-alpha",
      model: "claude-opus-4-20250514",
    }));
    useSettingsStore.getState().setSavedDefaults(makeConfig({
      workingDir: "/projects/myapp/.claude/worktrees/wt-beta",
      model: "claude-sonnet-4-20250514",
    }));
    const ws = useSettingsStore.getState().workspaceDefaults;
    // Only one key, with the latest settings
    expect(Object.keys(ws)).toHaveLength(1);
    expect(ws["/projects/myapp"].model).toBe("claude-sonnet-4-20250514");
  });

  it("preserves workspace defaults for different workspaces", () => {
    useSettingsStore.getState().setSavedDefaults(makeConfig({
      workingDir: "/projects/app-a",
      model: "claude-opus-4-20250514",
    }));
    useSettingsStore.getState().setSavedDefaults(makeConfig({
      workingDir: "/projects/app-b",
      model: "claude-sonnet-4-20250514",
    }));
    const ws = useSettingsStore.getState().workspaceDefaults;
    expect(Object.keys(ws)).toHaveLength(2);
    expect(ws["/projects/app-a"].model).toBe("claude-opus-4-20250514");
    expect(ws["/projects/app-b"].model).toBe("claude-sonnet-4-20250514");
  });

  it("skips workspace write when workingDir is empty", () => {
    useSettingsStore.getState().setSavedDefaults(makeConfig({ workingDir: "" }));
    const ws = useSettingsStore.getState().workspaceDefaults;
    expect(Object.keys(ws)).toHaveLength(0);
  });

  it("still writes global savedDefaults unchanged", () => {
    useSettingsStore.getState().setSavedDefaults(makeConfig());
    const saved = useSettingsStore.getState().savedDefaults!;
    expect(saved.workingDir).toBe("/projects/myapp");
    expect(saved.model).toBe("claude-sonnet-4-20250514");
    expect(saved.resumeSession).toBeNull();
    expect(saved.forkSession).toBe(false);
  });
});

describe("cacheSessionConfig", () => {
  beforeEach(() => {
    useSettingsStore.setState({ sessionConfigs: {} });
  });

  const makeConfig = (overrides: Record<string, unknown> = {}) => ({
    workingDir: "/projects/myapp",
    model: "gpt-5.5",
    permissionMode: "default" as const,
    codexSandboxMode: null,
    codexApprovalPolicy: null,
    dangerouslySkipPermissions: false,
    systemPrompt: null,
    appendSystemPrompt: null,
    allowedTools: [] as string[],
    disallowedTools: [] as string[],
    additionalDirs: [] as string[],
    mcpConfig: null,
    agent: null,
    effort: null,
    verbose: false,
    debug: false,
    maxBudget: null,
    resumeSession: null,
    forkSession: false,
    continueSession: false,
    projectDir: false,
    extraFlags: null,
    sessionId: null,
    runMode: false,
    cli: "codex" as const,
    ...overrides,
  });

  it("keeps Codex CLI identity for resume picker fallbacks", () => {
    useSettingsStore.getState().cacheSessionConfig("codex-session-id", makeConfig());

    expect(useSettingsStore.getState().sessionConfigs["codex-session-id"].cli).toBe("codex");
  });
});
