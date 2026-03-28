import { describe, it, expect, beforeEach } from "vitest";
import { ContextMeterAccumulator } from "../contextMeterAccumulator";
import type { SessionMetadata } from "../../types/session";

const META_STUB: SessionMetadata = {
  costUsd: 0.05,
  contextPercent: 42,
  durationSecs: 60,
  currentAction: null,
  nodeSummary: null,
  currentToolName: null,
  inputTokens: 5000,
  outputTokens: 2000,
  assistantMessageCount: 3,
  choiceHint: false,
  runtimeModel: "claude-opus-4-6",
  apiRegion: null,
  lastRequestId: null,
  subscriptionType: null,
  hookStatus: null,
  lastTurnCostUsd: 0,
  lastTurnTtftMs: 0,
  systemPromptLength: 0,
  toolCount: 0,
  conversationLength: 0,
  activeSubprocess: null,
  filesTouched: [],
  rateLimitRemaining: null,
  rateLimitReset: null,
  linesAdded: 0,
  linesRemoved: 0,
  lastToolDurationMs: null,
  lastToolResultSize: null,
  lastToolError: null,
  apiRetryCount: 0,
  apiErrorStatus: null,
  apiRetryInfo: null,
  stallDurationMs: 0,
  stallCount: 0,
  contextBudget: null,
  hookTelemetry: null,
  planOutcome: null,
  effortLevel: null,
  capturedSystemPrompt: null,
  worktreeInfo: null,
};

describe("ContextMeterAccumulator", () => {
  let acc: ContextMeterAccumulator;

  beforeEach(() => {
    acc = new ContextMeterAccumulator();
  });

  describe("ToolInput/ToolResult pairing", () => {
    it("pairs ToolInput with ToolResult to create a ToolCallRecord", () => {
      acc.process({
        kind: "ToolInput", ts: 0, toolName: "Read",
        input: { file_path: "/src/App.tsx" },
      });
      acc.process({
        kind: "ToolResult", ts: 1, toolName: "Read",
        durationMs: 15, toolResultSizeBytes: 4096, error: null,
      });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.recentToolCalls).toHaveLength(1);
      expect(snap.recentToolCalls[0].toolName).toBe("Read");
      expect(snap.recentToolCalls[0].filePath).toBe("/src/App.tsx");
      expect(snap.recentToolCalls[0].resultSizeBytes).toBe(4096);
      expect(snap.recentToolCalls[0].durationMs).toBe(15);
      expect(snap.recentToolCalls[0].error).toBe(false);
    });

    it("records error flag from ToolResult", () => {
      acc.process({
        kind: "ToolInput", ts: 0, toolName: "Bash",
        input: { command: "exit 1" },
      });
      acc.process({
        kind: "ToolResult", ts: 1, toolName: "Bash",
        durationMs: 100, toolResultSizeBytes: 50, error: "exit code 1",
      });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.recentToolCalls[0].error).toBe(true);
    });

    it("clears pendingToolInput on UserInput to prevent cross-turn mispairing", () => {
      acc.process({
        kind: "ToolInput", ts: 0, toolName: "Read",
        input: { file_path: "/old.ts" },
      });
      acc.process({
        kind: "UserInput", ts: 1, display: "next prompt", sessionId: "s1",
      });
      acc.process({
        kind: "ToolResult", ts: 2, toolName: "Read",
        durationMs: 10, toolResultSizeBytes: 100, error: null,
      });

      const snap = acc.snapshot("s1", "test", META_STUB);
      // Record created but file path not paired (pending was cleared)
      expect(snap.recentToolCalls).toHaveLength(1);
      expect(snap.recentToolCalls[0].filePath).toBeNull();
    });
  });

  describe("FileMetrics accumulation", () => {
    it("accumulates multiple reads of the same file", () => {
      for (let i = 0; i < 3; i++) {
        acc.process({
          kind: "ToolInput", ts: i * 2, toolName: "Read",
          input: { file_path: "/src/big.ts" },
        });
        acc.process({
          kind: "ToolResult", ts: i * 2 + 1, toolName: "Read",
          durationMs: 10, toolResultSizeBytes: 5000, error: null,
        });
      }

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.hotFiles).toHaveLength(1);
      expect(snap.hotFiles[0].filePath).toBe("/src/big.ts");
      expect(snap.hotFiles[0].readCount).toBe(3);
      expect(snap.hotFiles[0].cumulativeResultBytes).toBe(15000);
    });

    it("tracks read/write/edit counts separately", () => {
      acc.process({ kind: "ToolInput", ts: 0, toolName: "Read", input: { file_path: "/f.ts" } });
      acc.process({ kind: "ToolResult", ts: 1, toolName: "Read", durationMs: 5, toolResultSizeBytes: 100, error: null });

      acc.process({ kind: "ToolInput", ts: 2, toolName: "Write", input: { file_path: "/f.ts" } });
      acc.process({ kind: "ToolResult", ts: 3, toolName: "Write", durationMs: 5, toolResultSizeBytes: 200, error: null });

      acc.process({ kind: "ToolInput", ts: 4, toolName: "Edit", input: { file_path: "/f.ts" } });
      acc.process({ kind: "ToolResult", ts: 5, toolName: "Edit", durationMs: 5, toolResultSizeBytes: 50, error: null });

      const snap = acc.snapshot("s1", "test", META_STUB);
      const fm = snap.hotFiles[0];
      expect(fm.readCount).toBe(1);
      expect(fm.writeCount).toBe(1);
      expect(fm.editCount).toBe(1);
      expect(fm.cumulativeResultBytes).toBe(350);
    });

    it("sorts hot files desc by cumulativeResultBytes", () => {
      // Small file read many times
      for (let i = 0; i < 5; i++) {
        acc.process({ kind: "ToolInput", ts: i, toolName: "Read", input: { file_path: "/small.ts" } });
        acc.process({ kind: "ToolResult", ts: i, toolName: "Read", durationMs: 1, toolResultSizeBytes: 100, error: null });
      }
      // Big file read once
      acc.process({ kind: "ToolInput", ts: 10, toolName: "Read", input: { file_path: "/big.ts" } });
      acc.process({ kind: "ToolResult", ts: 11, toolName: "Read", durationMs: 50, toolResultSizeBytes: 50000, error: null });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.hotFiles[0].filePath).toBe("/big.ts");
      expect(snap.hotFiles[1].filePath).toBe("/small.ts");
    });
  });

  describe("ModelTokenBreakdown", () => {
    it("accumulates tokens per model with cached/uncached split", () => {
      acc.process({
        kind: "ApiTelemetry", ts: 0, model: "claude-opus-4-6", costUSD: 0.01,
        inputTokens: 100, outputTokens: 50, cachedInputTokens: 200,
        uncachedInputTokens: 100, durationMs: 1000, ttftMs: 500,
        queryChainId: null, queryDepth: 0, stopReason: null,
      });
      acc.process({
        kind: "ApiTelemetry", ts: 1, model: "claude-haiku-4-5-20251001", costUSD: 0.001,
        inputTokens: 50, outputTokens: 20, cachedInputTokens: 40,
        uncachedInputTokens: 50, durationMs: 200, ttftMs: 100,
        queryChainId: null, queryDepth: 1, stopReason: null,
      });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.modelBreakdowns).toHaveLength(2);

      const opus = snap.modelBreakdowns.find((m) => m.model === "claude-opus-4-6")!;
      expect(opus.inputTokens).toBe(300); // 100 + 200 cached
      expect(opus.cachedInputTokens).toBe(200);
      expect(opus.uncachedInputTokens).toBe(100);
      expect(opus.outputTokens).toBe(50);
      expect(opus.costUsd).toBe(0.01);
      expect(opus.callCount).toBe(1);

      const haiku = snap.modelBreakdowns.find((m) => m.model === "claude-haiku-4-5-20251001")!;
      expect(haiku.cachedInputTokens).toBe(40);
      expect(haiku.uncachedInputTokens).toBe(50);
    });

    it("deduplicates identical ApiTelemetry events", () => {
      const event = {
        kind: "ApiTelemetry" as const, ts: 0, model: "opus", costUSD: 0.01,
        inputTokens: 100, outputTokens: 50, cachedInputTokens: 200,
        uncachedInputTokens: 10, durationMs: 1000, ttftMs: 500,
        queryChainId: null, queryDepth: 0, stopReason: null,
      };
      acc.process(event);
      acc.process(event); // duplicate

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.modelBreakdowns[0].callCount).toBe(1);
    });
  });

  describe("ToolBreakdown", () => {
    it("accumulates per-tool stats", () => {
      acc.process({ kind: "ToolInput", ts: 0, toolName: "Read", input: { file_path: "/a.ts" } });
      acc.process({ kind: "ToolResult", ts: 1, toolName: "Read", durationMs: 10, toolResultSizeBytes: 1000, error: null });
      acc.process({ kind: "ToolInput", ts: 2, toolName: "Read", input: { file_path: "/b.ts" } });
      acc.process({ kind: "ToolResult", ts: 3, toolName: "Read", durationMs: 20, toolResultSizeBytes: 2000, error: null });
      acc.process({ kind: "ToolInput", ts: 4, toolName: "Bash", input: { command: "ls" } });
      acc.process({ kind: "ToolResult", ts: 5, toolName: "Bash", durationMs: 50, toolResultSizeBytes: 500, error: "exit 1" });

      const snap = acc.snapshot("s1", "test", META_STUB);
      const readTb = snap.toolBreakdowns.find((t) => t.toolName === "Read")!;
      expect(readTb.callCount).toBe(2);
      expect(readTb.totalResultBytes).toBe(3000);
      expect(readTb.totalDurationMs).toBe(30);
      expect(readTb.errorCount).toBe(0);

      const bashTb = snap.toolBreakdowns.find((t) => t.toolName === "Bash")!;
      expect(bashTb.errorCount).toBe(1);
    });
  });

  describe("Cache tracking", () => {
    it("computes cache hit rate from ApiTelemetry", () => {
      acc.process({
        kind: "ApiTelemetry", ts: 0, model: "opus", costUSD: 0.01,
        inputTokens: 50, outputTokens: 30, cachedInputTokens: 150,
        uncachedInputTokens: 50, durationMs: 500, ttftMs: 200,
        queryChainId: null, queryDepth: 0, stopReason: null,
      });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.totalCachedInputTokens).toBe(150);
      expect(snap.totalUncachedInputTokens).toBe(50);
      expect(snap.cacheHitRate).toBe(75); // 150 / (150 + 50) * 100
    });

    it("creates CacheSnapshot from TurnStart + ApiTelemetry pair", () => {
      acc.process({
        kind: "TurnStart", ts: 0, model: "opus",
        inputTokens: 0, outputTokens: 0, cacheRead: 120000, cacheCreation: 5000,
      });
      acc.process({
        kind: "ApiTelemetry", ts: 1, model: "opus", costUSD: 0.01,
        inputTokens: 50, outputTokens: 30, cachedInputTokens: 120,
        uncachedInputTokens: 50, durationMs: 500, ttftMs: 200,
        queryChainId: null, queryDepth: 0, stopReason: null,
      });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.cacheHistory).toHaveLength(1);
      expect(snap.cacheHistory[0].cacheRead).toBe(120000);
      expect(snap.cacheHistory[0].cacheCreation).toBe(5000);
      expect(snap.cacheHistory[0].cachedInputTokens).toBe(120);
      expect(snap.cacheHistory[0].uncachedInputTokens).toBe(50);
      expect(snap.cacheHistory[0].turnIndex).toBe(1);
    });

    it("tracks lastCacheRead and lastCacheCreation from TurnStart", () => {
      acc.process({
        kind: "TurnStart", ts: 0, model: "opus",
        inputTokens: 0, outputTokens: 0, cacheRead: 80000, cacheCreation: 3000,
      });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.lastCacheRead).toBe(80000);
      expect(snap.lastCacheCreation).toBe(3000);
    });

    it("caps cacheHistory ring buffer at 100", () => {
      for (let i = 0; i < 110; i++) {
        acc.process({
          kind: "TurnStart", ts: i * 2, model: "opus",
          inputTokens: 0, outputTokens: 0, cacheRead: i * 1000, cacheCreation: 0,
        });
        acc.process({
          kind: "ApiTelemetry", ts: i * 2 + 1, model: "opus", costUSD: 0.001,
          inputTokens: 10, outputTokens: 5, cachedInputTokens: i,
          uncachedInputTokens: 10 - Math.min(i, 10), durationMs: 100, ttftMs: 50,
          queryChainId: null, queryDepth: 0, stopReason: null,
        });
      }

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.cacheHistory).toHaveLength(100);
      // First entry should be turn 11 (oldest 10 evicted)
      expect(snap.cacheHistory[0].turnIndex).toBe(11);
    });
  });

  describe("Ring buffer eviction", () => {
    it("evicts oldest tool call records at cap 500", () => {
      for (let i = 0; i < 510; i++) {
        acc.process({ kind: "ToolInput", ts: i, toolName: "Read", input: { file_path: `/f${i}.ts` } });
        acc.process({ kind: "ToolResult", ts: i, toolName: "Read", durationMs: 1, toolResultSizeBytes: 10, error: null });
      }

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.recentToolCalls).toHaveLength(500);
      // Oldest records (0-9) evicted; first remaining is f10
      expect(snap.recentToolCalls[0].filePath).toBe("/f10.ts");
    });
  });

  describe("reset()", () => {
    it("clears all state including pendingToolInput", () => {
      acc.process({ kind: "ToolInput", ts: 0, toolName: "Read", input: { file_path: "/a.ts" } });
      acc.process({
        kind: "ApiTelemetry", ts: 1, model: "opus", costUSD: 0.01,
        inputTokens: 100, outputTokens: 50, cachedInputTokens: 200,
        uncachedInputTokens: 10, durationMs: 1000, ttftMs: 500,
        queryChainId: null, queryDepth: 0, stopReason: null,
      });

      acc.reset();

      // After reset, a ToolResult should not pair with the pre-reset ToolInput
      acc.process({ kind: "ToolResult", ts: 2, toolName: "Read", durationMs: 5, toolResultSizeBytes: 100, error: null });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.recentToolCalls).toHaveLength(1);
      expect(snap.recentToolCalls[0].filePath).toBeNull(); // not paired
      expect(snap.modelBreakdowns).toHaveLength(0); // cleared
      expect(snap.totalCachedInputTokens).toBe(0);
      expect(snap.cacheHistory).toHaveLength(0);
    });
  });

  describe("ToolInput/ToolResult mismatch pairing", () => {
    it("does not pair filePath when ToolInput and ToolResult tool names differ", () => {
      acc.process({ kind: "ToolInput", ts: 0, toolName: "Read", input: { file_path: "/a.ts" } });
      acc.process({ kind: "ToolResult", ts: 1, toolName: "Bash", durationMs: 10, toolResultSizeBytes: 50, error: null });

      const snap = acc.snapshot("s1", "test", META_STUB);
      expect(snap.recentToolCalls).toHaveLength(1);
      expect(snap.recentToolCalls[0].toolName).toBe("Bash");
      expect(snap.recentToolCalls[0].filePath).toBeNull();
    });
  });

  describe("snapshot() metadata pass-through", () => {
    it("reads canonical values from SessionMetadata", () => {
      const snap = acc.snapshot("s1", "test-session", META_STUB);
      expect(snap.sessionId).toBe("s1");
      expect(snap.sessionName).toBe("test-session");
      expect(snap.contextPercent).toBe(42);
      expect(snap.totalInputTokens).toBe(5000);
      expect(snap.totalOutputTokens).toBe(2000);
      expect(snap.totalCostUsd).toBe(0.05);
    });
  });
});
