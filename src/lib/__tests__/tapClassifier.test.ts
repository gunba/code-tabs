import { describe, it, expect } from "vitest";
import { classifyTapEntry } from "../tapClassifier";
import type { TapEntry } from "../../types/tapEvents";

describe("classifyTapEntry — parse (SSE)", () => {
  it("classifies message_start → TurnStart", () => {
    const entry: TapEntry = {
      ts: 1000, cat: "parse", len: 200,
      snap: JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-6", usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 } } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "TurnStart", ts: 1000, model: "claude-opus-4-6", inputTokens: 100, outputTokens: 0, cacheRead: 5000, cacheCreation: 200 });
  });

  it("classifies content_block_start thinking → ThinkingStart", () => {
    const entry: TapEntry = {
      ts: 1001, cat: "parse", len: 100,
      snap: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "ThinkingStart", ts: 1001, index: 0 });
  });

  it("classifies content_block_start text → TextStart", () => {
    const entry: TapEntry = {
      ts: 1002, cat: "parse", len: 100,
      snap: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "TextStart", ts: 1002, index: 1 });
  });

  it("classifies content_block_start tool_use → ToolCallStart", () => {
    const entry: TapEntry = {
      ts: 1003, cat: "parse", len: 200,
      snap: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Agent", id: "toolu_abc" } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "ToolCallStart", ts: 1003, index: 1, toolName: "Agent", toolId: "toolu_abc" });
  });

  it("classifies content_block_stop → BlockStop", () => {
    const entry: TapEntry = {
      ts: 1004, cat: "parse", len: 50,
      snap: JSON.stringify({ type: "content_block_stop", index: 0 }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "BlockStop", ts: 1004, index: 0 });
  });

  it("classifies message_delta → TurnEnd", () => {
    const entry: TapEntry = {
      ts: 1005, cat: "parse", len: 150,
      snap: JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 180 } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "TurnEnd", ts: 1005, stopReason: "tool_use", outputTokens: 180 });
  });

  it("classifies message_stop → MessageStop", () => {
    const entry: TapEntry = {
      ts: 1006, cat: "parse", len: 30,
      snap: JSON.stringify({ type: "message_stop" }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "MessageStop", ts: 1006 });
  });

  it("returns null for content_block_delta (high frequency noise)", () => {
    const entry: TapEntry = {
      ts: 1007, cat: "parse", len: 100,
      snap: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    };
    expect(classifyTapEntry(entry)).toBeNull();
  });

  it("returns null for invalid snap JSON", () => {
    const entry: TapEntry = { ts: 1008, cat: "parse", len: 10, snap: "not json" };
    expect(classifyTapEntry(entry)).toBeNull();
  });
});

describe("classifyTapEntry — stringify (outgoing)", () => {
  it("classifies display event → UserInput", () => {
    const entry: TapEntry = {
      ts: 2000, cat: "stringify", len: 200,
      snap: JSON.stringify({ display: "test prompt", pastedContents: {}, timestamp: 1774524049171, sessionId: "abc-123" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("UserInput");
    if (event?.kind === "UserInput") {
      expect(event.display).toBe("test prompt");
      expect(event.sessionId).toBe("abc-123");
    }
  });

  it("classifies slash command display → SlashCommand", () => {
    const entry: TapEntry = {
      ts: 2001, cat: "stringify", len: 100,
      snap: JSON.stringify({ display: "/rj", pastedContents: {}, timestamp: 1774524049171, sessionId: "abc-123" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SlashCommand");
    if (event?.kind === "SlashCommand") {
      expect(event.command).toBe("/rj");
      expect(event.display).toBe("/rj");
    }
  });

  it("classifies API telemetry → ApiTelemetry", () => {
    const entry: TapEntry = {
      ts: 2002, cat: "stringify", len: 300,
      snap: JSON.stringify({
        model: "claude-opus-4-6", costUSD: 0.0145, inputTokens: 3, outputTokens: 180,
        cachedInputTokens: 20194, uncachedInputTokens: 32, durationMs: 4232,
        ttftMs: 1907, queryChainId: "abc-123", queryDepth: 0, stop_reason: "tool_use",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("ApiTelemetry");
    if (event?.kind === "ApiTelemetry") {
      expect(event.costUSD).toBe(0.0145);
      expect(event.ttftMs).toBe(1907);
    }
  });

  it("classifies process health → ProcessHealth", () => {
    const entry: TapEntry = {
      ts: 2003, cat: "stringify", len: 100,
      snap: JSON.stringify({ rss: 562814976, heapUsed: 39393222, heapTotal: 31844352, uptime: 42.5, cpuPercent: 0 }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("ProcessHealth");
  });

  it("classifies rate limit → RateLimit", () => {
    const entry: TapEntry = {
      ts: 2004, cat: "stringify", len: 50,
      snap: JSON.stringify({ status: "allowed_warning", hoursTillReset: 16 }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("RateLimit");
  });

  it("classifies hook progress → HookProgress", () => {
    const entry: TapEntry = {
      ts: 2005, cat: "stringify", len: 200,
      snap: JSON.stringify({ type: "progress", data: { type: "hook_progress", hookEvent: "PostToolUse", hookName: "PostToolUse:Write", command: "tsc", statusMessage: "Type-checking..." } }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("HookProgress");
    if (event?.kind === "HookProgress") {
      expect(event.hookEvent).toBe("PostToolUse");
    }
  });

  it("classifies session registration → SessionRegistration", () => {
    const entry: TapEntry = {
      ts: 2006, cat: "stringify", len: 200,
      snap: JSON.stringify({ pid: 17004, sessionId: "de09698e", cwd: "/projects/app", startedAt: 1774524039860, name: "test-session" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SessionRegistration");
    if (event?.kind === "SessionRegistration") {
      expect(event.pid).toBe(17004);
      expect(event.sessionId).toBe("de09698e");
    }
  });

  it("classifies custom title → CustomTitle", () => {
    const entry: TapEntry = {
      ts: 2007, cat: "stringify", len: 100,
      snap: JSON.stringify({ type: "custom-title", customTitle: "my-feature", sessionId: "abc-123" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("CustomTitle");
  });

  it("classifies queue-operation completed → SubagentNotification", () => {
    const entry: TapEntry = {
      ts: 2008, cat: "stringify", len: 200,
      snap: JSON.stringify({ type: "queue-operation", operation: "enqueue", content: '<task-notification><status>completed</status><summary>Agent "Write limericks" completed</summary></task-notification>' }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubagentNotification");
    if (event?.kind === "SubagentNotification") {
      expect(event.status).toBe("completed");
      expect(event.summary).toContain("Write limericks");
    }
  });

  it("classifies queue-operation killed → SubagentNotification", () => {
    const entry: TapEntry = {
      ts: 2009, cat: "stringify", len: 200,
      snap: JSON.stringify({ type: "queue-operation", operation: "enqueue", content: '<task-notification><status>killed</status><summary>Agent stopped</summary></task-notification>' }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubagentNotification");
    if (event?.kind === "SubagentNotification") {
      expect(event.status).toBe("killed");
    }
  });

  it("extracts multiline summary from queue-operation", () => {
    const entry: TapEntry = {
      ts: 2010, cat: "stringify", len: 300,
      snap: JSON.stringify({
        type: "queue-operation", operation: "enqueue",
        content: '<task-notification><status>completed</status><summary>Line one\nLine two\nLine three</summary></task-notification>',
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubagentNotification");
    if (event?.kind === "SubagentNotification") {
      expect(event.summary).toBe("Line one\nLine two\nLine three");
    }
  });

  it("classifies scope:subagent_end → SubagentLifecycle end", () => {
    const entry: TapEntry = {
      ts: 2100, cat: "stringify", len: 97,
      snap: JSON.stringify({ rh: "abc123", scope: "subagent_end", last_request_id: "req-123" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubagentLifecycle");
    if (event?.kind === "SubagentLifecycle") {
      expect(event.variant).toBe("end");
      expect(event.agentType).toBeNull();
      expect(event.totalTokens).toBeNull();
    }
  });

  it("classifies user interruption → UserInterruption", () => {
    const entry: TapEntry = {
      ts: 2010, cat: "stringify", len: 200,
      snap: JSON.stringify({ type: "user", message: { role: "user", content: "[Request interrupted by user for tool use]" }, uuid: "abc" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("UserInterruption");
    if (event?.kind === "UserInterruption") {
      expect(event.forToolUse).toBe(true);
    }
  });

  it("classifies non-tool interruption", () => {
    const entry: TapEntry = {
      ts: 2011, cat: "stringify", len: 200,
      snap: JSON.stringify({ type: "user", message: { role: "user", content: "[Request interrupted by user]" }, uuid: "abc" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("UserInterruption");
    if (event?.kind === "UserInterruption") {
      expect(event.forToolUse).toBe(false);
    }
  });

  it("classifies permission rejected → PermissionRejected", () => {
    const entry: TapEntry = {
      ts: 2012, cat: "stringify", len: 300,
      snap: JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "abc", content: "The user doesn't want to proceed with this tool use. The tool use was rejected" }] }, uuid: "abc" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("PermissionRejected");
  });

  it("classifies Agent tool input → SubagentSpawn with subagentType and model", () => {
    const entry: TapEntry = {
      ts: 2013, cat: "stringify", len: 200,
      snap: JSON.stringify({
        description: "Write horse limericks", prompt: "Write a limerick about horses...",
        subagent_type: "Explore", model: "sonnet",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubagentSpawn");
    if (event?.kind === "SubagentSpawn") {
      expect(event.description).toBe("Write horse limericks");
      expect(event.subagentType).toBe("Explore");
      expect(event.model).toBe("sonnet");
    }
  });

  it("classifies Agent tool input → SubagentSpawn with undefined subagentType when absent", () => {
    const entry: TapEntry = {
      ts: 2013, cat: "stringify", len: 200,
      snap: JSON.stringify({ description: "Simple task", prompt: "Do something" }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubagentSpawn");
    if (event?.kind === "SubagentSpawn") {
      expect(event.subagentType).toBeUndefined();
      expect(event.model).toBeUndefined();
    }
  });

  it("classifies session resume → SessionResume", () => {
    const entry: TapEntry = {
      ts: 2014, cat: "stringify", len: 200,
      snap: JSON.stringify({ type: "assistant", message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "No response requested." }] } }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SessionResume");
  });

  it("returns null for unrecognized stringify objects", () => {
    const entry: TapEntry = {
      ts: 2015, cat: "stringify", len: 100,
      snap: JSON.stringify({ some: "random", data: true }),
    };
    expect(classifyTapEntry(entry)).toBeNull();
  });

  it("classifies notification_type idle_prompt → IdlePrompt", () => {
    const entry: TapEntry = {
      ts: 2020, cat: "stringify", len: 50,
      snap: JSON.stringify({ notification_type: "idle_prompt" }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "IdlePrompt", ts: 2020 });
  });

  it("classifies notification_type permission_prompt → PermissionPromptShown", () => {
    const entry: TapEntry = {
      ts: 2030, cat: "stringify", len: 60,
      snap: JSON.stringify({ notification_type: "permission_prompt" }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "PermissionPromptShown", ts: 2030, toolName: null });
  });

  it("returns null for other notification_type values", () => {
    const entry: TapEntry = {
      ts: 2021, cat: "stringify", len: 50,
      snap: JSON.stringify({ notification_type: "other_thing" }),
    };
    expect(classifyTapEntry(entry)).toBeNull();
  });
});

describe("classifyTapEntry — fetch", () => {
  it("classifies fetch → ApiFetch", () => {
    const entry: TapEntry = {
      ts: 3000, cat: "fetch",
      url: "https://api.anthropic.com/v1/messages", method: "POST", status: 200, bodyLen: 78286, dur: 4232,
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("ApiFetch");
    if (event?.kind === "ApiFetch") {
      expect(event.bodyLen).toBe(78286);
      expect(event.durationMs).toBe(4232);
    }
  });
});

describe("classifyTapEntry — spawn", () => {
  it("classifies bun spawn → BunOp", () => {
    const entry: TapEntry = {
      ts: 4000, cat: "bun",
      op: "spawn", cmd: "bash.exe -c npm test", cwd: "/projects/app", pid: 12345,
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("BunOp");
    if (event?.kind === "BunOp") {
      expect(event.op).toBe("spawn");
      expect(event.cmd).toBe("bash.exe -c npm test");
      expect(event.pid).toBe(12345);
    }
  });

  it("classifies spawn → SubprocessSpawn", () => {
    const entry: TapEntry = {
      ts: 4001, cat: "spawn",
      cmd: "git status", cwd: null, pid: 12346,
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubprocessSpawn");
  });
});

describe("classifyTapEntry — effort level", () => {
  it("classifies settings object with effortLevel → EffortLevel", () => {
    const entry: TapEntry = {
      ts: 5000, cat: "stringify", len: 775,
      snap: JSON.stringify({
        cleanupPeriodDays: 365,
        permissions: { defaultMode: "bypassPermissions" },
        effortLevel: "high",
        autoUpdatesChannel: "latest",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "EffortLevel", ts: 5000, level: "high" });
  });

  it("classifies medium effort level", () => {
    const entry: TapEntry = {
      ts: 5001, cat: "stringify", len: 777,
      snap: JSON.stringify({
        permissions: { defaultMode: "default" },
        effortLevel: "medium",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "EffortLevel", ts: 5001, level: "medium" });
  });
});

describe("classifyTapEntry — worktree events", () => {
  it("classifies worktree-state with session → WorktreeState", () => {
    const entry: TapEntry = {
      ts: 4500, cat: "stringify", len: 400,
      snap: JSON.stringify({
        type: "worktree-state",
        worktreeSession: {
          originalCwd: "C:\\Users\\test\\project",
          worktreePath: "C:\\Users\\test\\project\\.claude\\worktrees\\my-wt",
          worktreeName: "my-wt",
          worktreeBranch: "worktree-my-wt",
        },
        sessionId: "abc-123",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "WorktreeState", ts: 4500,
      originalCwd: "C:\\Users\\test\\project",
      worktreePath: "C:\\Users\\test\\project\\.claude\\worktrees\\my-wt",
      worktreeName: "my-wt",
      worktreeBranch: "worktree-my-wt",
    });
  });

  it("classifies worktree-state with null session → WorktreeCleared", () => {
    const entry: TapEntry = {
      ts: 4600, cat: "stringify", len: 99,
      snap: JSON.stringify({
        type: "worktree-state",
        worktreeSession: null,
        sessionId: "abc-123",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "WorktreeCleared", ts: 4600 });
  });
});

describe("classifyTapEntry — permission events", () => {
  it("classifies setMode array → PermissionPromptShown", () => {
    const entry: TapEntry = {
      ts: 4700, cat: "stringify", len: 300,
      snap: JSON.stringify([{ type: "setMode", acceptEdits: true, destination: "tool_use" }]),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "PermissionPromptShown", ts: 4700, toolName: null });
  });

  it("classifies telemetry shape → PermissionPromptShown with toolName", () => {
    const entry: TapEntry = {
      ts: 4701, cat: "stringify", len: 200,
      snap: JSON.stringify({ toolName: "Bash", decisionReasonType: "user_prompt", sandboxEnabled: false }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "PermissionPromptShown", ts: 4701, toolName: "Bash" });
  });

  it("classifies addRules array → PermissionPromptShown with toolName", () => {
    const entry: TapEntry = {
      ts: 4702, cat: "stringify", len: 322,
      snap: JSON.stringify([{
        type: "addRules",
        rules: [
          { toolName: "Bash", ruleContent: "rm -rf /tmp/test" },
          { toolName: "Bash", ruleContent: "mkdir -p /tmp/test" },
        ],
        behavior: "allow", destination: "localSettings",
      }]),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "PermissionPromptShown", ts: 4702, toolName: "Bash" });
  });

  it("classifies accept telemetry → PermissionApproved", () => {
    const entry: TapEntry = {
      ts: 4702, cat: "stringify", len: 200,
      snap: JSON.stringify({ toolName: "Edit", has_instructions: false, entered_feedback_mode: false }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "PermissionApproved", ts: 4702, toolName: "Edit" });
  });

  it("classifies user message with toolUseResult → SkillInvocation", () => {
    const entry: TapEntry = {
      ts: 4800, cat: "stringify", len: 500,
      snap: JSON.stringify({
        type: "user",
        toolUseResult: { success: true, commandName: "keybindings-help", allowedTools: ["Read"] },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "Launching skill: keybindings-help" }] },
        uuid: "u1", parentUuid: "p1",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "SkillInvocation", ts: 4800,
      skill: "keybindings-help",
      success: true,
      allowedTools: ["Read"],
    });
  });

  it("classifies failed skill invocation → SkillInvocation with success=false", () => {
    const entry: TapEntry = {
      ts: 4801, cat: "stringify", len: 500,
      snap: JSON.stringify({
        type: "user",
        toolUseResult: { success: false, commandName: "commit", allowedTools: [] },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_456", content: "Skill failed" }] },
        uuid: "u2", parentUuid: "p2",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "SkillInvocation", ts: 4801,
      skill: "commit",
      success: false,
      allowedTools: [],
    });
  });

  it("SkillInvocation takes priority over UserInterruption for skill result messages", () => {
    // A skill result message that also contains interruption-like text should still be classified as SkillInvocation
    const entry: TapEntry = {
      ts: 4802, cat: "stringify", len: 500,
      snap: JSON.stringify({
        type: "user",
        toolUseResult: { success: true, commandName: "review", allowedTools: ["Read", "Grep"] },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_789", content: "[Request interrupted by user" }] },
        uuid: "u3",
      }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SkillInvocation");
  });
});

describe("classifyTapEntry — system-prompt", () => {
  it("classifies system-prompt entry → SystemPromptCapture", () => {
    const entry: TapEntry = {
      ts: 4800, cat: "system-prompt",
      text: "You are Claude, an AI assistant...",
      model: "claude-opus-4-6",
      msgCount: 3,
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "SystemPromptCapture", ts: 4800,
      text: "You are Claude, an AI assistant...",
      model: "claude-opus-4-6",
      messageCount: 3,
      blocks: undefined,
    });
  });

  it("forwards blocks with cacheControl from system-prompt entry", () => {
    const entry: TapEntry = {
      ts: 4801, cat: "system-prompt",
      text: "Block 1Block 2",
      model: "claude-opus-4-6",
      msgCount: 2,
      blocks: [
        { text: "Block 1", cc: { type: "ephemeral" } },
        { text: "Block 2" },
      ],
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "SystemPromptCapture", ts: 4801,
      text: "Block 1Block 2",
      model: "claude-opus-4-6",
      messageCount: 2,
      blocks: [
        { text: "Block 1", cacheControl: { type: "ephemeral" } },
        { text: "Block 2" },
      ],
    });
  });
});

describe("classifyTapEntry — parse errors", () => {
  it("classifies API stream error → ApiStreamError", () => {
    const entry: TapEntry = {
      ts: 4900, cat: "parse", len: 150,
      snap: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" }, status: 529 }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "ApiStreamError", ts: 4900,
      type: "overloaded_error",
      message: "Overloaded",
      status: 529,
    });
  });
});

describe("classifyTapEntry — unclassified categories", () => {
  it("returns null for console entries", () => {
    const entry: TapEntry = { ts: 5000, cat: "console.log", msg: "test" };
    expect(classifyTapEntry(entry)).toBeNull();
  });

  it("returns null for fs entries", () => {
    const entry: TapEntry = { ts: 5001, cat: "fs.read", path: "/etc/hosts" };
    expect(classifyTapEntry(entry)).toBeNull();
  });

  it("returns null for timer entries", () => {
    const entry: TapEntry = { ts: 5002, cat: "setTimeout", delay: 1000 };
    expect(classifyTapEntry(entry)).toBeNull();
  });
});

describe("classifyTapEntry — status-line", () => {
  it("classifies status-line entry → StatusLineUpdate", () => {
    const entry: TapEntry = {
      ts: 6000, cat: "status-line",
      sessionId: "abc123",
      cwd: "/current/working/directory",
      modelId: "claude-opus-4-6[1m]",
      modelDisplayName: "Opus 4.6 (1M context)",
      cliVersion: "2.1.80",
      outputStyle: "default",
      totalCostUsd: 0.01234,
      totalDurationMs: 45000,
      totalApiDurationMs: 2300,
      totalLinesAdded: 156,
      totalLinesRemoved: 23,
      totalInputTokens: 50113,
      totalOutputTokens: 10462,
      contextWindowSize: 1000000,
      currentInputTokens: 8500,
      currentOutputTokens: 1200,
      cacheCreationInputTokens: 5000,
      cacheReadInputTokens: 2000,
      contextUsedPercent: 8,
      contextRemainingPercent: 92,
      exceeds200kTokens: false,
      fiveHourUsedPercent: 42,
      fiveHourResetsAt: 1774020000,
      sevenDayUsedPercent: 15,
      sevenDayResetsAt: 1774540000,
      vimMode: "NORMAL",
    };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "StatusLineUpdate", ts: 6000,
      sessionId: "abc123",
      cwd: "/current/working/directory",
      modelId: "claude-opus-4-6[1m]",
      modelDisplayName: "Opus 4.6 (1M context)",
      cliVersion: "2.1.80",
      outputStyle: "default",
      totalCostUsd: 0.01234,
      totalDurationMs: 45000,
      totalApiDurationMs: 2300,
      totalLinesAdded: 156,
      totalLinesRemoved: 23,
      totalInputTokens: 50113,
      totalOutputTokens: 10462,
      contextWindowSize: 1000000,
      currentInputTokens: 8500,
      currentOutputTokens: 1200,
      cacheCreationInputTokens: 5000,
      cacheReadInputTokens: 2000,
      contextUsedPercent: 8,
      contextRemainingPercent: 92,
      exceeds200kTokens: false,
      fiveHourUsedPercent: 42,
      fiveHourResetsAt: 1774020000,
      sevenDayUsedPercent: 15,
      sevenDayResetsAt: 1774540000,
      vimMode: "NORMAL",
    });
  });

  it("handles missing fields with defaults", () => {
    const entry: TapEntry = { ts: 6001, cat: "status-line" };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({
      kind: "StatusLineUpdate", ts: 6001,
      sessionId: "", cwd: "", modelId: "", modelDisplayName: "",
      cliVersion: "", outputStyle: "",
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
  });

  it("passes through exceeds200kTokens: true", () => {
    const entry: TapEntry = {
      ts: 6002, cat: "status-line",
      exceeds200kTokens: true,
    };
    const event = classifyTapEntry(entry);
    expect(event).not.toBeNull();
    if (event?.kind === "StatusLineUpdate") {
      expect(event.exceeds200kTokens).toBe(true);
    }
  });
});

describe("classifyTapEntry — ping", () => {
  it("classifies cat=ping as HttpPing", () => {
    const entry: TapEntry = { ts: 1000, cat: "ping", dur: 87, status: 200 };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "HttpPing", ts: 1000, durationMs: 87, status: 200 });
  });

  it("handles missing dur/status gracefully", () => {
    const entry: TapEntry = { ts: 1000, cat: "ping" };
    const event = classifyTapEntry(entry);
    expect(event).toMatchObject({ kind: "HttpPing", ts: 1000, durationMs: 0, status: null });
  });
});
