import { describe, it, expect } from "vitest";
import { TapMetadataAccumulator } from "../tapMetadataAccumulator";

describe("TapMetadataAccumulator", () => {
  it("accumulates cost from ApiTelemetry events", () => {
    const acc = new TapMetadataAccumulator();
    const diff1 = acc.process({
      kind: "ApiTelemetry", ts: 0, model: "opus", costUSD: 0.01,
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 200,
      uncachedInputTokens: 10, durationMs: 1000, ttftMs: 500,
      queryChainId: null, queryDepth: 0, stopReason: null,
    });
    expect(diff1?.costUsd).toBe(0.01);
    expect(diff1?.inputTokens).toBe(300); // 100 + 200 cached

    const diff2 = acc.process({
      kind: "ApiTelemetry", ts: 1, model: "opus", costUSD: 0.02,
      inputTokens: 50, outputTokens: 25, cachedInputTokens: 100,
      uncachedInputTokens: 5, durationMs: 500, ttftMs: 200,
      queryChainId: null, queryDepth: 0, stopReason: null,
    });
    expect(diff2?.costUsd).toBe(0.03); // accumulated
    expect(diff2?.outputTokens).toBe(75); // 50 + 25
  });

  it("sets runtimeModel from TurnStart", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "TurnStart", ts: 0, model: "claude-opus-4-6", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0,
    });
    expect(diff?.runtimeModel).toBe("claude-opus-4-6");
  });

  it("sets currentToolName from ToolCallStart", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "ToolCallStart", ts: 0, index: 0, toolName: "Bash", toolId: "t1",
    });
    expect(diff?.currentToolName).toBe("Bash");
  });

  it("sets nodeSummary from first UserInput", () => {
    const acc = new TapMetadataAccumulator();
    const diff1 = acc.process({
      kind: "UserInput", ts: 0, display: "first message", sessionId: "s1",
    });
    expect(diff1?.nodeSummary).toBe("first message");

    // Second UserInput with different tool state still has first nodeSummary
    acc.process({ kind: "ToolCallStart", ts: 1, index: 0, toolName: "Bash", toolId: "t1" });
    const diff2 = acc.process({
      kind: "UserInput", ts: 2, display: "second message", sessionId: "s1",
    });
    // nodeSummary stays as first message
    expect(diff2?.nodeSummary).toBe("first message");
  });

  it("clears transients on TurnEnd end_turn", () => {
    const acc = new TapMetadataAccumulator();
    acc.process({ kind: "ToolCallStart", ts: 0, index: 0, toolName: "Bash", toolId: "t1" });
    const diff = acc.process({
      kind: "TurnEnd", ts: 1, stopReason: "end_turn", outputTokens: 100,
    });
    expect(diff?.currentToolName).toBeNull();
    expect(diff?.currentAction).toBeNull();
  });

  it("returns null when nothing changed", () => {
    const acc = new TapMetadataAccumulator();
    // ProcessHealth doesn't trigger metadata changes
    const diff = acc.process({
      kind: "ProcessHealth", ts: 0, rss: 100, heapUsed: 50, heapTotal: 60, uptime: 10, cpuPercent: 0,
    });
    expect(diff).toBeNull();
  });

  it("reset clears all state", () => {
    const acc = new TapMetadataAccumulator();
    acc.process({
      kind: "ApiTelemetry", ts: 0, model: "opus", costUSD: 0.01,
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 0,
      uncachedInputTokens: 0, durationMs: 100, ttftMs: 50,
      queryChainId: null, queryDepth: 0, stopReason: null,
    });
    acc.reset();
    const diff = acc.process({
      kind: "ApiTelemetry", ts: 1, model: "opus", costUSD: 0.005,
      inputTokens: 10, outputTokens: 5, cachedInputTokens: 0,
      uncachedInputTokens: 0, durationMs: 50, ttftMs: 25,
      queryChainId: null, queryDepth: 0, stopReason: null,
    });
    expect(diff?.costUsd).toBe(0.005); // reset, not accumulated
  });

  it("stores capturedSystemPrompt from SystemPromptCapture", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "SystemPromptCapture", ts: 0,
      text: "You are a helpful assistant",
      model: "claude-opus-4-6",
      messageCount: 3,
    });
    expect(diff?.capturedSystemPrompt).toBe("You are a helpful assistant");
  });

  it("TurnDuration returns null (duration managed by client-side timer)", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "TurnDuration", ts: 0, durationMs: 5000, messageCount: 3,
    });
    expect(diff).toBeNull();
  });

  it("clears worktreeInfo on WorktreeCleared", () => {
    const acc = new TapMetadataAccumulator();
    // Enter worktree
    const enterDiff = acc.process({
      kind: "WorktreeState", ts: 0,
      originalCwd: "C:\\project",
      worktreePath: "C:\\project\\.claude\\worktrees\\my-wt",
      worktreeName: "my-wt",
      worktreeBranch: "worktree-my-wt",
    });
    expect(enterDiff?.worktreeInfo).toEqual({
      originalCwd: "C:\\project",
      worktreePath: "C:\\project\\.claude\\worktrees\\my-wt",
      worktreeName: "my-wt",
      worktreeBranch: "worktree-my-wt",
    });
    // Exit worktree
    const exitDiff = acc.process({ kind: "WorktreeCleared", ts: 1 });
    expect(exitDiff?.worktreeInfo).toBeNull();
  });

  it("tracks effortLevel from EffortLevel event", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({ kind: "EffortLevel", ts: 0, level: "high" });
    expect(diff?.effortLevel).toBe("high");

    // Change to medium
    const diff2 = acc.process({ kind: "EffortLevel", ts: 1, level: "medium" });
    expect(diff2?.effortLevel).toBe("medium");
  });

  it("resets effortLevel on reset()", () => {
    const acc = new TapMetadataAccumulator();
    acc.process({ kind: "EffortLevel", ts: 0, level: "max" });
    acc.reset();
    // After reset, next event should not carry old effort
    const diff = acc.process({ kind: "TurnStart", ts: 1, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 });
    expect(diff?.effortLevel).toBeNull();
  });

  it("stores apiLatencyMs from ApiFetch with cfRay", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "ApiFetch", ts: 0,
      url: "https://api.anthropic.com/v1/messages", method: "POST",
      status: 200, bodyLen: 50000, durationMs: 245,
      requestId: "req-1", cfRay: "abc123-IAD",
      rateLimitRemaining: "1000", rateLimitReset: "2026-01-01T00:00:00Z",
    });
    expect(diff?.apiLatencyMs).toBe(245);
  });

  it("does not store apiLatencyMs from ApiFetch without cfRay", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "ApiFetch", ts: 0,
      url: "https://other-service.example.com/api", method: "GET",
      status: 200, bodyLen: 1000, durationMs: 50,
      requestId: null, cfRay: null,
      rateLimitRemaining: null, rateLimitReset: null,
    });
    expect(diff?.apiLatencyMs).toBeNull();
  });

  it("uses contextBudget.totalContextSize as denominator when available", () => {
    const acc = new TapMetadataAccumulator();
    // Set contextBudget with totalContextSize = 100000
    acc.process({
      kind: "ContextBudget", ts: 0,
      claudeMdSize: 2000, totalContextSize: 100000,
      mcpToolsCount: 5, mcpToolsTokens: 3000,
      nonMcpToolsCount: 20, nonMcpToolsTokens: 15000,
      projectFileCount: 10,
    });
    // TurnStart with cacheRead = 50000 → should be 50% of 100000, not 25% of 200000
    acc.process({
      kind: "TurnStart", ts: 1, model: "opus",
      inputTokens: 0, outputTokens: 0, cacheRead: 50000, cacheCreation: 0,
    });
    // Need an ApiTelemetry to trigger diff with the right context%
    const diff = acc.process({
      kind: "ApiTelemetry", ts: 2, model: "opus", costUSD: 0.01,
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, uncachedInputTokens: 100,
      durationMs: 500, ttftMs: 200, queryChainId: null, queryDepth: 0, stopReason: null,
    });
    expect(diff?.contextPercent).toBe(50); // 50000/100000*100, not 50000/200000*100=25
  });

  it("accumulates statusLine from StatusLineUpdate event", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "StatusLineUpdate", ts: 0,
      sessionId: "abc123", cwd: "/tmp", modelId: "opus", modelDisplayName: "Opus",
      cliVersion: "2.1.80", outputStyle: "default",
      totalCostUsd: 0.05, totalDurationMs: 60000, totalApiDurationMs: 3000,
      totalLinesAdded: 100, totalLinesRemoved: 10,
      totalInputTokens: 50000, totalOutputTokens: 10000,
      contextWindowSize: 1000000,
      currentInputTokens: 8000, currentOutputTokens: 1000,
      cacheCreationInputTokens: 4000, cacheReadInputTokens: 2000,
      contextUsedPercent: 5, contextRemainingPercent: 95,
      exceeds200kTokens: false,
      fiveHourUsedPercent: 42, fiveHourResetsAt: 1774020000,
      sevenDayUsedPercent: 15, sevenDayResetsAt: 1774540000,
      vimMode: "NORMAL",
    });
    expect(diff?.statusLine).not.toBeNull();
    expect(diff?.statusLine?.cliVersion).toBe("2.1.80");
    expect(diff?.statusLine?.fiveHourUsedPercent).toBe(42);
    expect(diff?.statusLine?.contextWindowSize).toBe(1000000);
    expect(diff?.statusLine?.sevenDayUsedPercent).toBe(15);
    expect(diff?.statusLine?.vimMode).toBe("NORMAL");
    expect(diff?.statusLine?.cacheCreationInputTokens).toBe(4000);
    expect(diff?.statusLine?.cacheReadInputTokens).toBe(2000);
  });

  it("updates statusLine on subsequent StatusLineUpdate", () => {
    const acc = new TapMetadataAccumulator();
    acc.process({
      kind: "StatusLineUpdate", ts: 0,
      sessionId: "", cwd: "", modelId: "", modelDisplayName: "",
      cliVersion: "2.1.79", outputStyle: "",
      totalCostUsd: 0, totalDurationMs: 0, totalApiDurationMs: 0,
      totalLinesAdded: 0, totalLinesRemoved: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      contextWindowSize: 0,
      currentInputTokens: 0, currentOutputTokens: 0,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      contextUsedPercent: 0, contextRemainingPercent: 0,
      exceeds200kTokens: false,
      fiveHourUsedPercent: 10, fiveHourResetsAt: 0,
      sevenDayUsedPercent: 5, sevenDayResetsAt: 0,
      vimMode: "",
    });
    const diff = acc.process({
      kind: "StatusLineUpdate", ts: 1,
      sessionId: "", cwd: "", modelId: "", modelDisplayName: "",
      cliVersion: "2.1.80", outputStyle: "",
      totalCostUsd: 0, totalDurationMs: 0, totalApiDurationMs: 0,
      totalLinesAdded: 0, totalLinesRemoved: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      contextWindowSize: 0,
      currentInputTokens: 0, currentOutputTokens: 0,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      contextUsedPercent: 0, contextRemainingPercent: 0,
      exceeds200kTokens: false,
      fiveHourUsedPercent: 50, fiveHourResetsAt: 0,
      sevenDayUsedPercent: 20, sevenDayResetsAt: 0,
      vimMode: "INSERT",
    });
    expect(diff?.statusLine?.cliVersion).toBe("2.1.80");
    expect(diff?.statusLine?.fiveHourUsedPercent).toBe(50);
    expect(diff?.statusLine?.vimMode).toBe("INSERT");
  });

  it("resets statusLine on reset()", () => {
    const acc = new TapMetadataAccumulator();
    acc.process({
      kind: "StatusLineUpdate", ts: 0,
      sessionId: "", cwd: "", modelId: "", modelDisplayName: "",
      cliVersion: "2.1.80", outputStyle: "",
      totalCostUsd: 0, totalDurationMs: 0, totalApiDurationMs: 0,
      totalLinesAdded: 0, totalLinesRemoved: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      contextWindowSize: 0,
      currentInputTokens: 0, currentOutputTokens: 0,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      contextUsedPercent: 0, contextRemainingPercent: 0,
      exceeds200kTokens: false,
      fiveHourUsedPercent: 0, fiveHourResetsAt: 0,
      sevenDayUsedPercent: 0, sevenDayResetsAt: 0,
      vimMode: "",
    });
    acc.reset();
    // After reset, next diff should have statusLine: null
    const diff = acc.process({
      kind: "TurnStart", ts: 1, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0,
    });
    expect(diff?.statusLine).toBeNull();
  });
});
