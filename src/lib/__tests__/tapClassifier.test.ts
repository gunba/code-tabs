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
    expect(event).toEqual({ kind: "TurnStart", ts: 1000, model: "claude-opus-4-6", inputTokens: 100, outputTokens: 0, cacheRead: 5000, cacheCreation: 200 });
  });

  it("classifies content_block_start thinking → ThinkingStart", () => {
    const entry: TapEntry = {
      ts: 1001, cat: "parse", len: 100,
      snap: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toEqual({ kind: "ThinkingStart", ts: 1001, index: 0 });
  });

  it("classifies content_block_start text → TextStart", () => {
    const entry: TapEntry = {
      ts: 1002, cat: "parse", len: 100,
      snap: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toEqual({ kind: "TextStart", ts: 1002, index: 1 });
  });

  it("classifies content_block_start tool_use → ToolCallStart", () => {
    const entry: TapEntry = {
      ts: 1003, cat: "parse", len: 200,
      snap: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Agent", id: "toolu_abc" } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toEqual({ kind: "ToolCallStart", ts: 1003, index: 1, toolName: "Agent", toolId: "toolu_abc" });
  });

  it("classifies content_block_stop → BlockStop", () => {
    const entry: TapEntry = {
      ts: 1004, cat: "parse", len: 50,
      snap: JSON.stringify({ type: "content_block_stop", index: 0 }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toEqual({ kind: "BlockStop", ts: 1004, index: 0 });
  });

  it("classifies message_delta → TurnEnd", () => {
    const entry: TapEntry = {
      ts: 1005, cat: "parse", len: 150,
      snap: JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 180 } }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toEqual({ kind: "TurnEnd", ts: 1005, stopReason: "tool_use", outputTokens: 180 });
  });

  it("classifies message_stop → MessageStop", () => {
    const entry: TapEntry = {
      ts: 1006, cat: "parse", len: 30,
      snap: JSON.stringify({ type: "message_stop" }),
    };
    const event = classifyTapEntry(entry);
    expect(event).toEqual({ kind: "MessageStop", ts: 1006 });
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

  it("classifies Agent tool input → SubagentSpawn", () => {
    const entry: TapEntry = {
      ts: 2013, cat: "stringify", len: 200,
      snap: JSON.stringify({ description: "Write horse limericks", prompt: "Write a limerick about horses..." }),
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubagentSpawn");
    if (event?.kind === "SubagentSpawn") {
      expect(event.description).toBe("Write horse limericks");
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
  it("classifies bun.spawn → SubprocessSpawn", () => {
    const entry: TapEntry = {
      ts: 4000, cat: "bun.spawn",
      cmd: "bash.exe -c npm test", cwd: "/projects/app", pid: 12345,
    };
    const event = classifyTapEntry(entry);
    expect(event?.kind).toBe("SubprocessSpawn");
    if (event?.kind === "SubprocessSpawn") {
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
    expect(event).toEqual({
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
    expect(event).toEqual({ kind: "WorktreeCleared", ts: 4600 });
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
