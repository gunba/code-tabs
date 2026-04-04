/**
 * Tests for TapSubagentTracker — covers cases NOT in subagentAwareness.test.ts.
 *
 * subagentAwareness.test.ts already covers:
 *   - hasActiveAgents (empty, active, after idle)
 *   - stale cleanup on UserInput
 *   - SubagentLifecycle end/killed marks dead, enriches metadata
 *   - SubagentNotification marks dead
 *   - tool name prefix stripping (known, unknown, bare)
 *   - costUsd accumulation
 *
 * This file covers the remaining process() paths, reset(), edge cases,
 * and multi-agent scenarios not exercised there.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TapSubagentTracker } from "../tapSubagentTracker";
import type { TapEvent, ConversationMessage, SubagentSpawn, ApiTelemetry } from "../../types/tapEvents";

// ── Helpers ──

function makeSpawn(description = "test agent", prompt = "do stuff", overrides: Partial<SubagentSpawn> = {}): SubagentSpawn {
  return { kind: "SubagentSpawn", ts: 1, description, prompt, ...overrides };
}

function makeSidechainMsg(
  agentId: string,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    kind: "ConversationMessage",
    ts: 2,
    messageType: "assistant",
    isSidechain: true,
    agentId,
    uuid: null,
    parentUuid: null,
    promptId: null,
    stopReason: "tool_use",
    toolNames: ["Bash"],
    toolAction: "Bash: ls",
    textSnippet: null,
    cwd: null,
    hasToolError: false,
    toolErrorText: null,
    ...overrides,
  };
}

function makeTelemetry(queryDepth: number, overrides: Partial<ApiTelemetry> = {}): ApiTelemetry {
  return {
    kind: "ApiTelemetry",
    ts: 5,
    model: "haiku",
    costUSD: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    uncachedInputTokens: 100,
    durationMs: 200,
    ttftMs: 50,
    queryChainId: null,
    queryDepth,
    stopReason: "end_turn",
    ...overrides,
  };
}

function spawnAndActivate(tracker: TapSubagentTracker, agentId: string, desc = "agent"): void {
  tracker.process(makeSpawn(desc));
  tracker.process(makeSidechainMsg(agentId));
}

// ── Tests ──

describe("TapSubagentTracker", () => {
  let tracker: TapSubagentTracker;

  beforeEach(() => {
    tracker = new TapSubagentTracker("session-1");
  });

  // ── Unhandled event kinds ──

  it("returns empty array for unhandled event kinds", () => {
    const actions = tracker.process({ kind: "ThinkingStart", ts: 1, index: 0 } as TapEvent);
    expect(actions).toEqual([]);
  });

  // ── SubagentSpawn queuing ──

  describe("SubagentSpawn", () => {
    it("queues description without creating a subagent", () => {
      const actions = tracker.process(makeSpawn("my agent"));
      expect(actions).toEqual([]);
      expect(tracker.hasActiveAgents()).toBe(false);
    });

    it("queues multiple descriptions consumed in FIFO order", () => {
      tracker.process(makeSpawn("first"));
      tracker.process(makeSpawn("second"));

      const actionsA = tracker.process(makeSidechainMsg("agent-a"));
      expect(actionsA.find(a => a.type === "add")!.subagent!.description).toBe("first");

      const actionsB = tracker.process(makeSidechainMsg("agent-b"));
      expect(actionsB.find(a => a.type === "add")!.subagent!.description).toBe("second");
    });
  });

  // ── ConversationMessage filtering ──

  describe("ConversationMessage filtering", () => {
    it("ignores non-sidechain messages", () => {
      tracker.process(makeSpawn());
      const actions = tracker.process(makeSidechainMsg("agent-1", { isSidechain: false }));
      expect(actions).toEqual([]);
      expect(tracker.hasActiveAgents()).toBe(false);
    });

    it("ignores messages without agentId", () => {
      tracker.process(makeSpawn());
      const actions = tracker.process(makeSidechainMsg("agent-1", { agentId: null }));
      expect(actions).toEqual([]);
    });

    it("uses 'Agent' as default description when no pending spawn", () => {
      const actions = tracker.process(makeSidechainMsg("agent-1"));
      const addAction = actions.find(a => a.type === "add");
      expect(addAction!.subagent!.description).toBe("Agent");
    });
  });

  // ── Subagent creation ──

  describe("subagent creation", () => {
    it("emits add on first sidechain message", () => {
      tracker.process(makeSpawn("my desc"));
      const actions = tracker.process(makeSidechainMsg("agent-1"));

      expect(actions[0].type).toBe("add");
      const addAction = actions.find(a => a.type === "add")!;
      expect(addAction.subagent!.id).toBe("agent-1");
      expect(addAction.subagent!.description).toBe("my desc");
      expect(addAction.subagent!.state).toBe("starting");
      expect(addAction.subagent!.tokenCount).toBe(0);
      expect(addAction.subagent!.messages).toEqual([]);
      expect(addAction.subagent!.parentSessionId).toBe("session-1");
    });

    it("uses the event timestamp for createdAt", () => {
      tracker.process(makeSpawn());
      const actions = tracker.process(makeSidechainMsg("agent-1", { ts: 42 }));
      expect(actions.find(a => a.type === "add")!.subagent!.createdAt).toBe(42);
    });

    it("propagates subagentType and model from spawn to created subagent", () => {
      tracker.process(makeSpawn("review code", "review", { subagentType: "reviewer", model: "sonnet" }));
      const actions = tracker.process(makeSidechainMsg("agent-1"));
      const addAction = actions.find(a => a.type === "add")!;
      expect(addAction.subagent!.subagentType).toBe("reviewer");
      expect(addAction.subagent!.model).toBe("sonnet");
    });

    it("propagates promptText from spawn to created subagent", () => {
      tracker.process(makeSpawn("search files", "find all TypeScript files in src/"));
      const actions = tracker.process(makeSidechainMsg("agent-1"));
      const addAction = actions.find(a => a.type === "add")!;
      expect(addAction.subagent!.promptText).toBe("find all TypeScript files in src/");
    });

    it("leaves subagentType/model undefined when not in spawn", () => {
      tracker.process(makeSpawn("basic agent"));
      const actions = tracker.process(makeSidechainMsg("agent-1"));
      const addAction = actions.find(a => a.type === "add")!;
      expect(addAction.subagent!.subagentType).toBeUndefined();
      expect(addAction.subagent!.model).toBeUndefined();
    });
  });

  // ── State derivation from stopReason / messageType ──

  describe("state derivation", () => {
    it("thinking when stopReason is null (assistant)", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process(makeSidechainMsg("agent-1", { stopReason: null }));
      expect(actions.find(a => a.type === "update")!.updates!.state).toBe("thinking");
    });

    it("thinking for user messageType regardless of stopReason", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process(makeSidechainMsg("agent-1", { messageType: "user", stopReason: "end_turn" }));
      expect(actions.find(a => a.type === "update")!.updates!.state).toBe("thinking");
    });

    it("idle for result messageType", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process(makeSidechainMsg("agent-1", { messageType: "result" }));
      expect(actions.find(a => a.type === "update")!.updates!.state).toBe("idle");
    });
  });

  // ── Message accumulation ──

  describe("message accumulation", () => {
    it("includes both text and tool messages in a single update", () => {
      // Activate with no tool action so the only messages come from the test message
      tracker.process(makeSpawn());
      tracker.process(makeSidechainMsg("agent-1", {
        toolAction: null, toolNames: [], textSnippet: null,
      }));

      const actions = tracker.process(makeSidechainMsg("agent-1", {
        textSnippet: "Working on it",
        toolAction: "Bash: echo hi",
        toolNames: ["Bash"],
      }));
      const msgs = actions.find(a => a.type === "update" && a.updates?.messages)!.updates!.messages!;
      expect(msgs.filter(m => m.role === "assistant")).toHaveLength(1);
      expect(msgs.filter(m => m.role === "tool")).toHaveLength(1);
    });

    it("caps messages at 200 entries", () => {
      spawnAndActivate(tracker, "agent-1");
      for (let i = 0; i < 205; i++) {
        tracker.process(makeSidechainMsg("agent-1", {
          ts: 10 + i,
          textSnippet: `msg-${i}`,
          toolAction: null,
          toolNames: [],
        }));
      }
      const lastActions = tracker.process(makeSidechainMsg("agent-1", {
        ts: 999,
        textSnippet: "final",
        toolAction: null,
        toolNames: [],
      }));
      expect(lastActions.find(a => a.type === "update")!.updates!.messages!.length).toBeLessThanOrEqual(200);
    });
  });

  // ── Late message suppression ──

  describe("late message suppression", () => {
    it("drops messages for agents marked dead", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.process({ kind: "SubagentNotification", ts: 5, status: "completed", summary: "" } as TapEvent);

      const actions = tracker.process(makeSidechainMsg("agent-1", { ts: 10 }));
      expect(actions).toEqual([]);
      expect(tracker.hasActiveAgents()).toBe(false);
    });

    it("drops messages for agents marked idle", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.process(makeSidechainMsg("agent-1", { stopReason: "end_turn" }));

      const actions = tracker.process(makeSidechainMsg("agent-1", { ts: 20 }));
      expect(actions).toEqual([]);
    });

    it("drops messages for agents marked interrupted", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.process({ kind: "UserInterruption", ts: 5, forToolUse: false } as TapEvent);

      const actions = tracker.process(makeSidechainMsg("agent-1", { ts: 20 }));
      expect(actions).toEqual([]);
    });
  });

  // ── Completion: resultText and completed flag ──

  describe("completion tracking", () => {
    it("sets completed and resultText from SubagentNotification with status=completed", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process({
        kind: "SubagentNotification", ts: 10, status: "completed", summary: "Found 3 matching files",
      } as TapEvent);
      const resultUpdate = actions.find(a => a.subagentId === "agent-1" && a.updates?.resultText);
      expect(resultUpdate).toBeDefined();
      expect(resultUpdate!.updates!.resultText).toBe("Found 3 matching files");
      expect(resultUpdate!.updates!.completed).toBe(true);
      // All active agents get completed: true + state: dead
      const stateUpdate = actions.find(a => a.updates?.state === "dead");
      expect(stateUpdate!.updates!.completed).toBe(true);
    });

    it("does NOT set completed on SubagentNotification with status=killed", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process({
        kind: "SubagentNotification", ts: 10, status: "killed", summary: "",
      } as TapEvent);
      // Should use markAllActive("dead") which does not set completed
      expect(actions.every(a => !a.updates?.completed)).toBe(true);
      expect(actions.some(a => a.updates?.state === "dead")).toBe(true);
    });

    it("sets completed on SubagentLifecycle end", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process({
        kind: "SubagentLifecycle", ts: 10, variant: "end",
        agentType: null, isAsync: null, model: null,
        totalTokens: null, totalToolUses: 5, durationMs: 3000, reason: null,
      } as TapEvent);
      const deadUpdate = actions.find(a => a.updates?.state === "dead");
      expect(deadUpdate!.updates!.completed).toBe(true);
    });

    it("does NOT set completed on SubagentLifecycle killed", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process({
        kind: "SubagentLifecycle", ts: 10, variant: "killed",
        agentType: null, isAsync: null, model: null,
        totalTokens: null, totalToolUses: null, durationMs: null, reason: null,
      } as TapEvent);
      expect(actions.every(a => !a.updates?.completed)).toBe(true);
      expect(actions.some(a => a.updates?.state === "dead")).toBe(true);
    });
  });

  // ── Nested Agent tool → grandchild description queuing ──

  describe("nested Agent tool description queuing", () => {
    it("queues description from Agent tool_use for grandchild", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.process(makeSidechainMsg("agent-1", {
        toolAction: "Agent: Summarize the code",
        toolNames: ["Agent"],
      }));
      const actions = tracker.process(makeSidechainMsg("agent-2"));
      expect(actions.find(a => a.type === "add")!.subagent!.description).toBe("Summarize the code");
    });
  });

  // ── ApiTelemetry edge cases ──

  describe("ApiTelemetry", () => {
    it("ignores queryDepth 0 (parent session telemetry)", () => {
      spawnAndActivate(tracker, "agent-1");
      expect(tracker.process(makeTelemetry(0))).toEqual([]);
    });

    it("returns empty when no lastActiveAgent exists", () => {
      expect(tracker.process(makeTelemetry(1))).toEqual([]);
    });

    it("includes model in updates when present", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process(makeTelemetry(1, { model: "claude-haiku-4-5-20251001" }));
      expect(actions.find(a => a.type === "update")!.updates!.model).toBe("claude-haiku-4-5-20251001");
    });
  });

  // ── UserInterruption ──

  describe("UserInterruption", () => {
    it("is a no-op when no active agents", () => {
      const actions = tracker.process({ kind: "UserInterruption", ts: 10, forToolUse: true } as TapEvent);
      expect(actions).toEqual([]);
    });
  });

  // ── SlashCommand stale cleanup ──

  describe("SlashCommand", () => {
    it("marks active agents idle on SlashCommand", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process({
        kind: "SlashCommand", ts: 10, command: "/help", display: "/help",
      } as TapEvent);
      expect(tracker.hasActiveAgents()).toBe(false);
      expect(actions.some(a => a.updates?.state === "idle")).toBe(true);
    });

    it("is a no-op when all agents already dead", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.process({ kind: "SubagentNotification", ts: 5, status: "completed", summary: "" } as TapEvent);
      const actions = tracker.process({
        kind: "SlashCommand", ts: 10, command: "/help", display: "/help",
      } as TapEvent);
      expect(actions).toEqual([]);
    });
  });

  // ── SubagentLifecycle start ──

  describe("SubagentLifecycle start", () => {
    it("enriches with agentType, isAsync, model", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process({
        kind: "SubagentLifecycle", ts: 5, variant: "start",
        agentType: "code_review", isAsync: true, model: "haiku",
        totalTokens: null, totalToolUses: null, durationMs: null, reason: null,
      } as TapEvent);
      const update = actions.find(a => a.type === "update")!;
      expect(update.updates!.agentType).toBe("code_review");
      expect(update.updates!.isAsync).toBe(true);
      expect(update.updates!.model).toBe("haiku");
    });

    it("is a no-op when no lastActiveAgent", () => {
      const actions = tracker.process({
        kind: "SubagentLifecycle", ts: 5, variant: "start",
        agentType: "code_review", isAsync: false, model: null,
        totalTokens: null, totalToolUses: null, durationMs: null, reason: null,
      } as TapEvent);
      expect(actions).toEqual([]);
    });
  });

  // ── SubagentLifecycle end without metadata ──

  describe("SubagentLifecycle end without metadata", () => {
    it("still marks agents dead when no toolUses/durationMs", () => {
      spawnAndActivate(tracker, "agent-1");
      const actions = tracker.process({
        kind: "SubagentLifecycle", ts: 10, variant: "end",
        agentType: null, isAsync: null, model: null,
        totalTokens: null, totalToolUses: null, durationMs: null, reason: null,
      } as TapEvent);
      expect(tracker.hasActiveAgents()).toBe(false);
      expect(actions.some(a => a.updates?.state === "dead")).toBe(true);
    });
  });

  // ── reset() ──

  describe("reset", () => {
    it("clears all tracked state", () => {
      spawnAndActivate(tracker, "agent-1");
      expect(tracker.hasActiveAgents()).toBe(true);

      tracker.reset();
      expect(tracker.hasActiveAgents()).toBe(false);
    });

    it("clears pending descriptions", () => {
      tracker.process(makeSpawn("leftover"));
      tracker.reset();
      // New agent should get default desc, not "leftover"
      const actions = tracker.process(makeSidechainMsg("agent-2"));
      expect(actions.find(a => a.type === "add")!.subagent!.description).toBe("Agent");
    });

    it("clears lastActiveAgent so telemetry is ignored", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.reset();
      const actions = tracker.process(makeTelemetry(1));
      expect(actions).toEqual([]);
    });
  });

  // ── isSubagentInFlight ──

  describe("isSubagentInFlight", () => {
    it("returns false with no activity", () => {
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("returns true after SubagentSpawn (before first sidechain message)", () => {
      tracker.process(makeSpawn("review code"));
      expect(tracker.isSubagentInFlight()).toBe(true);
    });

    it("returns true while agents are active", () => {
      spawnAndActivate(tracker, "agent-1");
      expect(tracker.isSubagentInFlight()).toBe(true);
    });

    it("returns false after all agents complete and sidechain clears", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.process({ kind: "SubagentNotification", ts: 10, status: "completed", summary: "" } as TapEvent);
      // sidechainActive still true until non-sidechain message
      expect(tracker.isSubagentInFlight()).toBe(true);
      // Non-sidechain message clears sidechainActive
      tracker.process({
        kind: "ConversationMessage", ts: 11, messageType: "user",
        isSidechain: false, agentId: null, uuid: null, parentUuid: null,
        promptId: null, stopReason: null, toolNames: [], toolAction: null,
        textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
      } as TapEvent);
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("returns false after reset()", () => {
      tracker.process(makeSpawn("test"));
      tracker.reset();
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("stale pendingSpawns drained by UserInterruption", () => {
      tracker.process(makeSpawn("will be interrupted"));
      expect(tracker.isSubagentInFlight()).toBe(true);
      tracker.process({ kind: "UserInterruption", ts: 5, forToolUse: false } as TapEvent);
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("stale pendingSpawns drained by UserInput", () => {
      tracker.process(makeSpawn("will be abandoned"));
      expect(tracker.isSubagentInFlight()).toBe(true);
      tracker.process({
        kind: "UserInput", ts: 5, display: "new prompt", sessionId: "s",
      } as TapEvent);
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("stale pendingSpawns drained by SlashCommand", () => {
      tracker.process(makeSpawn("will be abandoned"));
      expect(tracker.isSubagentInFlight()).toBe(true);
      tracker.process({
        kind: "SlashCommand", ts: 5, command: "/help", display: "/help",
      } as TapEvent);
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("covers the full timing gap: SubagentSpawn → SessionRegistration window → complete", () => {
      // 1. SubagentSpawn fires (main agent calls Agent tool)
      tracker.process(makeSpawn("review code"));
      expect(tracker.isSubagentInFlight()).toBe(true);  // pendingSpawns > 0

      // 2. ConversationMessage(assistant, isSidechain=false) — main agent tool_use (not modeled)
      // 3. Subagent's SessionRegistration arrives here — no state change, still guarded
      //    by pendingSpawns from step 1. Processor would suppress it.

      // 4. First sidechain ConversationMessage creates the subagent entry
      tracker.process(makeSidechainMsg("agent-1"));
      expect(tracker.isSubagentInFlight()).toBe(true);  // hasActiveAgents + sidechainActive

      // 5. Subagent works (more sidechain messages — not modeled)
      // 6. Subagent completes
      tracker.process({ kind: "SubagentNotification", ts: 20, status: "completed", summary: "" } as TapEvent);

      // Main agent resumes with non-sidechain message
      tracker.process({
        kind: "ConversationMessage", ts: 21, messageType: "assistant",
        isSidechain: false, agentId: null, uuid: null, parentUuid: null,
        promptId: null, stopReason: "end_turn", toolNames: [], toolAction: null,
        textSnippet: "Done", cwd: null, hasToolError: false, toolErrorText: null,
      } as TapEvent);

      // Now safe: all agents dead, sidechain cleared, no pending spawns
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("returns false after SubagentLifecycle end + non-sidechain ConversationMessage", () => {
      spawnAndActivate(tracker, "agent-1");
      tracker.process({
        kind: "SubagentLifecycle", ts: 10, variant: "end",
        agentType: null, isAsync: null, model: null,
        totalTokens: null, totalToolUses: null, durationMs: null, reason: null,
      } as TapEvent);
      // sidechainActive still set until non-sidechain message
      expect(tracker.isSubagentInFlight()).toBe(true);
      tracker.process({
        kind: "ConversationMessage", ts: 11, messageType: "user",
        isSidechain: false, agentId: null, uuid: null, parentUuid: null,
        promptId: null, stopReason: null, toolNames: [], toolAction: null,
        textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
      } as TapEvent);
      expect(tracker.isSubagentInFlight()).toBe(false);
    });

    it("handles parallel subagents — stays true until all complete", () => {
      tracker.process(makeSpawn("agent A"));
      tracker.process(makeSpawn("agent B"));
      tracker.process(makeSidechainMsg("agent-a"));
      tracker.process(makeSidechainMsg("agent-b"));
      expect(tracker.isSubagentInFlight()).toBe(true);

      // SubagentNotification marks ALL active dead
      tracker.process({ kind: "SubagentNotification", ts: 10, status: "completed", summary: "" } as TapEvent);
      expect(tracker.hasActiveAgents()).toBe(false);
      // sidechainActive still true until non-sidechain message
      expect(tracker.isSubagentInFlight()).toBe(true);

      tracker.process({
        kind: "ConversationMessage", ts: 11, messageType: "user",
        isSidechain: false, agentId: null, uuid: null, parentUuid: null,
        promptId: null, stopReason: null, toolNames: [], toolAction: null,
        textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
      } as TapEvent);
      expect(tracker.isSubagentInFlight()).toBe(false);
    });
  });

  // ── Multiple agents ──

  describe("multiple concurrent agents", () => {
    it("tracks two agents independently with correct descriptions", () => {
      tracker.process(makeSpawn("agent A desc"));
      tracker.process(makeSpawn("agent B desc"));

      const addA = tracker.process(makeSidechainMsg("agent-a")).find(a => a.type === "add")!;
      expect(addA.subagent!.description).toBe("agent A desc");

      const addB = tracker.process(makeSidechainMsg("agent-b")).find(a => a.type === "add")!;
      expect(addB.subagent!.description).toBe("agent B desc");
    });

    it("telemetry routes to lastActiveAgent", () => {
      spawnAndActivate(tracker, "agent-a");
      spawnAndActivate(tracker, "agent-b"); // now lastActiveAgent
      const actions = tracker.process(makeTelemetry(1, { inputTokens: 100, outputTokens: 50 }));
      expect(actions.find(a => a.type === "update")!.subagentId).toBe("agent-b");
    });
  });
});
