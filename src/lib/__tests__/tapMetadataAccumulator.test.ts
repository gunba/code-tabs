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
});
