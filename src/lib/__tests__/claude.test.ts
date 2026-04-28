// [DR-05] Add tests for any new pure-logic functions in src/lib/ and store actions in src/store/. claude.test.ts covers dirToTabName/modelLabel/modelColor/computeHeatLevel/sessionColor and friends from src/lib/claude.ts.
import { describe, it, expect, beforeEach } from "vitest";
import {
  dirToTabName,
  modelLabel,
  modelColor,
  formatTokenCount,
  computeHeatLevel,
  heatClassName,
  SESSION_COLORS,
  assignSessionColor,
  sessionColor,
  releaseSessionColor,
  getSessionColorIndex,
  forceSessionColor,
  getResumeId,
  effectiveModel,
  stripWorktreeFlags,
  findNearestLiveTab,
  toolCategoryColor,
  eventKindColor,
  getActivityColor,
  getActivityText,
  TOOL_COLORS,
  EVENT_KIND_COLORS,
  resolveResumeId,
} from "../claude";
import type { PastSession, Session } from "../../types/session";
import { DEFAULT_SESSION_CONFIG } from "../../types/session";

describe("dirToTabName", () => {
  it("extracts last path segment (Unix)", () => {
    expect(dirToTabName("/home/user/projects/my-app")).toBe("my-app");
  });

  it("extracts last path segment (Windows)", () => {
    expect(dirToTabName("C:\\Users\\jorda\\Desktop\\my-project")).toBe("my-project");
  });

  it("handles trailing slash", () => {
    expect(dirToTabName("/home/user/code/")).toBe("code");
  });

  it("returns full string when no separators", () => {
    expect(dirToTabName("my-project")).toBe("my-project");
  });
});

describe("modelLabel", () => {
  it("returns Default for null", () => {
    expect(modelLabel(null)).toBe("Default");
  });

  it("returns Opus for opus model", () => {
    expect(modelLabel("claude-opus-4-6")).toBe("Opus");
  });

  it("returns Sonnet for sonnet model", () => {
    expect(modelLabel("claude-sonnet-4-6")).toBe("Sonnet");
  });

  it("returns Haiku for haiku model", () => {
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku");
  });

  it("returns raw model string for unknown models", () => {
    expect(modelLabel("custom-model-v1")).toBe("custom-model-v1");
  });
});

describe("modelColor", () => {
  it("returns muted color for null", () => {
    expect(modelColor(null)).toBe("var(--text-muted)");
  });

  it("returns legendary orange for opus model", () => {
    expect(modelColor("claude-opus-4-6")).toBe("var(--rarity-legendary)");
  });

  it("returns epic purple for sonnet model", () => {
    expect(modelColor("claude-sonnet-4-6")).toBe("var(--rarity-epic)");
  });

  it("returns rare blue for haiku model", () => {
    expect(modelColor("claude-haiku-4-5-20251001")).toBe("var(--rarity-rare)");
  });

  it("returns muted color for unknown model", () => {
    expect(modelColor("custom-model-v1")).toBe("var(--text-muted)");
  });

  it("matches opus substring anywhere in model string", () => {
    expect(modelColor("some-opus-variant")).toBe("var(--rarity-legendary)");
  });

  it("matches sonnet substring anywhere in model string", () => {
    expect(modelColor("my-sonnet-4-20260101")).toBe("var(--rarity-epic)");
  });

  it("matches haiku substring anywhere in model string", () => {
    expect(modelColor("claude-3-haiku-20240307")).toBe("var(--rarity-rare)");
  });
});

describe("formatTokenCount", () => {
  it("returns raw number for small values", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("returns 0 for zero", () => {
    expect(formatTokenCount(0)).toBe("0");
  });

  it("formats thousands with one decimal for 1K-9.9K", () => {
    expect(formatTokenCount(1500)).toBe("1.5K");
    expect(formatTokenCount(2300)).toBe("2.3K");
    expect(formatTokenCount(9999)).toBe("10.0K");
  });

  it("formats thousands rounded for 10K+", () => {
    expect(formatTokenCount(10000)).toBe("10K");
    expect(formatTokenCount(36000)).toBe("36K");
    expect(formatTokenCount(999999)).toBe("1000K");
  });

  it("formats millions with one decimal", () => {
    expect(formatTokenCount(1200000)).toBe("1.2M");
    expect(formatTokenCount(5000000)).toBe("5.0M");
  });
});

describe("computeHeatLevel (WoW rarity: unused + 0-4, rank-based)", () => {
  it("returns -1 (poor/trash) for zero count", () => {
    expect(computeHeatLevel(0, 0, 5)).toBe(-1);
  });

  it("returns -1 (poor/trash) when totalUsed is 0", () => {
    expect(computeHeatLevel(1, 0, 0)).toBe(-1);
  });

  it("returns -1 (poor/trash) for negative count", () => {
    expect(computeHeatLevel(-1, 0, 5)).toBe(-1);
  });

  it("returns 4 (legendary) when only one command is used", () => {
    expect(computeHeatLevel(1, 0, 1)).toBe(4);
  });

  it("splits 10 used commands into 2 per rarity tier", () => {
    // rank 0..1 -> legendary, 2..3 -> epic, 4..5 -> rare, 6..7 -> uncommon, 8..9 -> common
    expect(computeHeatLevel(100, 0, 10)).toBe(4);
    expect(computeHeatLevel(50, 1, 10)).toBe(4);
    expect(computeHeatLevel(30, 2, 10)).toBe(3);
    expect(computeHeatLevel(20, 3, 10)).toBe(3);
    expect(computeHeatLevel(10, 4, 10)).toBe(2);
    expect(computeHeatLevel(5, 5, 10)).toBe(2);
    expect(computeHeatLevel(3, 6, 10)).toBe(1);
    expect(computeHeatLevel(2, 7, 10)).toBe(1);
    expect(computeHeatLevel(1, 8, 10)).toBe(0);
    expect(computeHeatLevel(1, 9, 10)).toBe(0);
  });

  it("places top rank in legendary, bottom rank in uncommon for 4 used", () => {
    expect(computeHeatLevel(10, 0, 4)).toBe(4);
    expect(computeHeatLevel(5, 1, 4)).toBe(3);
    expect(computeHeatLevel(2, 2, 4)).toBe(2);
    expect(computeHeatLevel(1, 3, 4)).toBe(1);
  });

  it("keeps tiers consecutive for totalUsed == 2 (no collapsed middle)", () => {
    // Previously totalUsed=2 gave [4, 1], skipping rare+epic. Now [4, 3].
    expect(computeHeatLevel(10, 0, 2)).toBe(4);
    expect(computeHeatLevel(1, 1, 2)).toBe(3);
  });

  it("keeps tiers consecutive for totalUsed == 3 (no skipped tier)", () => {
    // Previously totalUsed=3 gave [4, 2, 1], skipping epic. Now [4, 3, 2].
    expect(computeHeatLevel(10, 0, 3)).toBe(4);
    expect(computeHeatLevel(5, 1, 3)).toBe(3);
    expect(computeHeatLevel(1, 2, 3)).toBe(2);
  });

  it("uses all five rarity colors for totalUsed == 5", () => {
    expect(computeHeatLevel(10, 0, 5)).toBe(4);
    expect(computeHeatLevel(8, 1, 5)).toBe(3);
    expect(computeHeatLevel(6, 2, 5)).toBe(2);
    expect(computeHeatLevel(4, 3, 5)).toBe(1);
    expect(computeHeatLevel(2, 4, 5)).toBe(0);
  });

  it("guarantees epic tier appears in skewed power-law usage", () => {
    // Real-world skew: /r=500, /j=50, /b=10, /x=3, /y=1 — old ratio-based impl
    // would put everything except /r into uncommon. Rank-based spreads them out.
    const levels = [
      computeHeatLevel(500, 0, 5),
      computeHeatLevel(50, 1, 5),
      computeHeatLevel(10, 2, 5),
      computeHeatLevel(3, 3, 5),
      computeHeatLevel(1, 4, 5),
    ];
    expect(levels).toContain(4); // legendary
    expect(levels).toContain(3); // epic
    expect(levels).toContain(2); // rare
    expect(levels).toContain(1); // uncommon
    expect(levels).toContain(0); // common
  });
});

describe("heatClassName", () => {
  it("returns heat-unused for level -1 (Poor/trash)", () => {
    expect(heatClassName(-1)).toBe("heat-unused");
  });

  it("returns heat-0 for level 0 (Common)", () => {
    expect(heatClassName(0)).toBe("heat-0");
  });

  it("returns heat-1 for level 1 (Uncommon)", () => {
    expect(heatClassName(1)).toBe("heat-1");
  });

  it("returns heat-2 for level 2 (Rare)", () => {
    expect(heatClassName(2)).toBe("heat-2");
  });

  it("returns heat-3 for level 3 (Epic)", () => {
    expect(heatClassName(3)).toBe("heat-3");
  });

  it("returns heat-4 for level 4 (Legendary)", () => {
    expect(heatClassName(4)).toBe("heat-4");
  });
});

describe("session color assignment", () => {
  beforeEach(() => {
    // Clean up any state from previous tests
    for (let i = 0; i < 20; i++) {
      releaseSessionColor(`test-${i}`);
    }
  });

  it("assigns sequential colors to new sessions", () => {
    assignSessionColor("s1", []);
    assignSessionColor("s2", ["s1"]);
    const c1 = sessionColor("s1");
    const c2 = sessionColor("s2");
    expect(c1).not.toBe(c2);
    expect(SESSION_COLORS).toContain(c1);
    expect(SESSION_COLORS).toContain(c2);
    releaseSessionColor("s1");
    releaseSessionColor("s2");
  });

  it("avoids colors in use by existing sessions", () => {
    assignSessionColor("a", []);
    assignSessionColor("b", ["a"]);
    assignSessionColor("c", ["a", "b"]);
    const colors = [sessionColor("a"), sessionColor("b"), sessionColor("c")];
    // All three should be different
    expect(new Set(colors).size).toBe(3);
    releaseSessionColor("a");
    releaseSessionColor("b");
    releaseSessionColor("c");
  });

  it("does not reassign if already assigned", () => {
    assignSessionColor("x", []);
    const first = sessionColor("x");
    assignSessionColor("x", []); // second call should be no-op
    expect(sessionColor("x")).toBe(first);
    releaseSessionColor("x");
  });

  it("releaseSessionColor frees the color", () => {
    assignSessionColor("r", []);
    expect(getSessionColorIndex("r")).toBeGreaterThanOrEqual(0);
    releaseSessionColor("r");
    expect(getSessionColorIndex("r")).toBe(-1);
  });

  it("forceSessionColor overrides assignment", () => {
    assignSessionColor("f", []);
    forceSessionColor("f", 3);
    expect(sessionColor("f")).toBe(SESSION_COLORS[3]);
    releaseSessionColor("f");
  });

  it("sessionColor falls back to hash for unassigned sessions", () => {
    const color = sessionColor("never-assigned-session-id");
    expect(SESSION_COLORS).toContain(color);
  });

  it("getSessionColorIndex returns -1 for unassigned", () => {
    expect(getSessionColorIndex("nonexistent")).toBe(-1);
  });

  it("SESSION_COLORS has 8 entries", () => {
    expect(SESSION_COLORS).toHaveLength(8);
  });

  it("sessionColor is deterministic for same ID", () => {
    const id = "deterministic-test-id";
    const c1 = sessionColor(id);
    const c2 = sessionColor(id);
    expect(c1).toBe(c2);
  });
});

/** Helper: build a minimal Session for testing pure functions. */
function makeSession(overrides: {
  id?: string;
  resumeSession?: string | null;
  sessionId?: string | null;
  model?: string | null;
  runtimeModel?: string | null;
}): Session {
  return {
    id: overrides.id ?? "test-id",
    name: "test",
    config: {
      ...DEFAULT_SESSION_CONFIG,
      resumeSession: overrides.resumeSession ?? null,
      sessionId: overrides.sessionId ?? null,
      model: overrides.model ?? null,
    },
    state: "idle",
    metadata: {
      costUsd: 0,
      contextDebug: null,
      durationSecs: 0,
      currentAction: null,
      nodeSummary: null,
      currentToolName: null,
      currentEventKind: null,
      inputTokens: 0,
      outputTokens: 0,
      assistantMessageCount: 0,
      choiceHint: false,
      runtimeModel: overrides.runtimeModel ?? null,
      apiRegion: null, lastRequestId: null, subscriptionType: null, hookStatus: null,
      lastTurnCostUsd: 0, lastTurnTtftMs: 0, systemPromptLength: 0, toolCount: 0, conversationLength: 0,
      activeSubprocess: null, filesTouched: [], rateLimitRemaining: null, rateLimitReset: null, fiveHourPercent: null, fiveHourResetsAt: null, sevenDayPercent: null, sevenDayResetsAt: null, apiLatencyMs: 0, pingRttMs: 0, serverTimeMs: 0, tokPerSec: 0, linesAdded: 0, linesRemoved: 0, lastToolDurationMs: null, lastToolResultSize: null, lastToolError: null, apiRetryCount: 0, apiErrorStatus: null, apiRetryInfo: null, stallDurationMs: 0, stallCount: 0, contextBudget: null, hookTelemetry: null, planOutcome: null, effortLevel: null, worktreeInfo: null, capturedSystemPrompt: null, statusLine: null,
    },
    createdAt: "2026-01-01T00:00:00Z",
    lastActive: "2026-01-01T00:00:00Z",
  };
}

describe("getResumeId", () => {
  it("returns resumeSession when set", () => {
    const s = makeSession({ id: "app-id", resumeSession: "original-cli-id", sessionId: "mid-id" });
    expect(getResumeId(s)).toBe("original-cli-id");
  });

  it("falls back to sessionId when resumeSession is null", () => {
    const s = makeSession({ id: "app-id", resumeSession: null, sessionId: "cli-session-id" });
    expect(getResumeId(s)).toBe("cli-session-id");
  });

  it("falls back to session.id when both are null", () => {
    const s = makeSession({ id: "app-id", resumeSession: null, sessionId: null });
    expect(getResumeId(s)).toBe("app-id");
  });

  it("prefers resumeSession over sessionId", () => {
    const s = makeSession({ resumeSession: "resume-target", sessionId: "session-target" });
    expect(getResumeId(s)).toBe("resume-target");
  });

  it("returns empty resumeSession if it is an empty string", () => {
    // Empty string is falsy — should fall through to sessionId
    const s = makeSession({ resumeSession: "", sessionId: "fallback" });
    expect(getResumeId(s)).toBe("fallback");
  });
});

describe("resolveResumeId", () => {
  function past(p: { id: string; directory: string; lastModified: string; cli?: "claude" | "codex" }): PastSession {
    return {
      id: p.id,
      directory: p.directory,
      lastModified: p.lastModified,
      cli: p.cli ?? "claude",
      path: `/fake/${p.id}.jsonl`,
      filePath: `/fake/${p.id}.jsonl`,
      sizeBytes: 1024,
      firstMessage: "first",
      lastMessage: "last",
      parentId: null,
      model: "claude-opus-4-7",
      dirExists: true,
    };
  }

  function sessionFor(opts: {
    workingDir: string;
    sessionId?: string | null;
    resumeSession?: string | null;
    lastActive?: string;
    createdAt?: string;
  }): Session {
    const base = makeSession({
      sessionId: opts.sessionId ?? null,
      resumeSession: opts.resumeSession ?? null,
    });
    return {
      ...base,
      config: { ...base.config, workingDir: opts.workingDir },
      lastActive: opts.lastActive ?? base.lastActive,
      createdAt: opts.createdAt ?? base.createdAt,
    };
  }

  it("returns null when there are no past sessions in the cwd", () => {
    const s = sessionFor({ workingDir: "C:/dev/code-tabs" });
    const others = [past({ id: "abc", directory: "C:/dev/elsewhere", lastModified: "2026-04-28T10:00:00Z" })];
    expect(resolveResumeId(s, others)).toBeNull();
  });

  it("uses the stored sessionId verbatim when it matches a JSONL in the cwd", () => {
    const s = sessionFor({ workingDir: "C:/dev/code-tabs", sessionId: "wanted-id" });
    const ps = [
      past({ id: "wanted-id", directory: "C:/dev/code-tabs", lastModified: "2026-04-28T10:00:00Z" }),
      past({ id: "other-id", directory: "C:/dev/code-tabs", lastModified: "2026-04-28T11:00:00Z" }),
    ];
    expect(resolveResumeId(s, ps)).toBe("wanted-id");
  });

  it("returns the only candidate when cwd has exactly one JSONL", () => {
    // The dead tab carries an id that no JSONL matches (e.g. lost via TAP miss).
    const s = sessionFor({ workingDir: "C:/dev/code-tabs", sessionId: "phantom-id" });
    const ps = [past({ id: "real-id", directory: "C:/dev/code-tabs", lastModified: "2026-04-28T10:00:00Z" })];
    expect(resolveResumeId(s, ps)).toBe("real-id");
  });

  it("tie-breaks by closest lastModified to the dead tab's lastActive", () => {
    const s = sessionFor({
      workingDir: "C:/dev/code-tabs",
      sessionId: "phantom",
      lastActive: "2026-04-28T12:00:00Z",
    });
    const ps = [
      past({ id: "way-back", directory: "C:/dev/code-tabs", lastModified: "2026-04-20T10:00:00Z" }),
      past({ id: "closest",  directory: "C:/dev/code-tabs", lastModified: "2026-04-28T11:55:00Z" }),
      past({ id: "future",   directory: "C:/dev/code-tabs", lastModified: "2026-04-29T10:00:00Z" }),
    ];
    expect(resolveResumeId(s, ps)).toBe("closest");
  });

  it("normalizes path separators when matching cwd", () => {
    // Same project, different slash flavours — must match.
    const s = sessionFor({ workingDir: "C:\\dev\\code-tabs", sessionId: null });
    const ps = [past({ id: "real", directory: "C:/dev/code-tabs", lastModified: "2026-04-28T10:00:00Z" })];
    expect(resolveResumeId(s, ps)).toBe("real");
  });

  it("ignores Codex past sessions (different storage layer, not relevant to Claude --resume)", () => {
    const s = sessionFor({ workingDir: "C:/dev/code-tabs", sessionId: null });
    const ps = [
      past({ id: "codex-roll", directory: "C:/dev/code-tabs", lastModified: "2026-04-28T11:00:00Z", cli: "codex" }),
      past({ id: "claude-id",  directory: "C:/dev/code-tabs", lastModified: "2026-04-28T10:00:00Z" }),
    ];
    expect(resolveResumeId(s, ps)).toBe("claude-id");
  });
});

describe("effectiveModel", () => {
  it("returns config model when set", () => {
    const s = makeSession({ model: "claude-opus-4-6", runtimeModel: "claude-sonnet-4-6" });
    expect(effectiveModel(s)).toBe("claude-opus-4-6");
  });

  it("falls back to runtimeModel when config model is null", () => {
    const s = makeSession({ model: null, runtimeModel: "claude-sonnet-4-6" });
    expect(effectiveModel(s)).toBe("claude-sonnet-4-6");
  });

  it("returns null when both are null", () => {
    const s = makeSession({ model: null, runtimeModel: null });
    expect(effectiveModel(s)).toBeNull();
  });

  it("prefers config model over runtimeModel", () => {
    const s = makeSession({ model: "claude-haiku-4-5-20251001", runtimeModel: "claude-opus-4-6" });
    expect(effectiveModel(s)).toBe("claude-haiku-4-5-20251001");
  });

  it("returns null for empty string model (falsy)", () => {
    const s = makeSession({ model: "", runtimeModel: null });
    expect(effectiveModel(s)).toBeNull();
  });

  it("falls back to runtimeModel for empty string model", () => {
    const s = makeSession({ model: "", runtimeModel: "claude-sonnet-4-6" });
    expect(effectiveModel(s)).toBe("claude-sonnet-4-6");
  });
});

describe("stripWorktreeFlags", () => {
  it("returns null for null input", () => {
    expect(stripWorktreeFlags(null)).toBeNull();
  });

  it("strips -w alone", () => {
    expect(stripWorktreeFlags("-w")).toBeNull();
  });

  it("strips --worktree alone", () => {
    expect(stripWorktreeFlags("--worktree")).toBeNull();
  });

  it("strips -w among other flags", () => {
    expect(stripWorktreeFlags("-w --verbose")).toBe("--verbose");
  });

  it("strips --worktree among other flags", () => {
    expect(stripWorktreeFlags("--verbose --worktree --debug")).toBe("--verbose --debug");
  });

  it("preserves unrelated flags", () => {
    expect(stripWorktreeFlags("--verbose --debug")).toBe("--verbose --debug");
  });

  it("returns null for empty string", () => {
    expect(stripWorktreeFlags("")).toBeNull();
  });

  it("does not strip -watch (false positive guard)", () => {
    expect(stripWorktreeFlags("-watch")).toBe("-watch");
  });

  it("does not strip --width (false positive guard)", () => {
    expect(stripWorktreeFlags("--width 80")).toBe("--width 80");
  });

  it("strips multiple occurrences of -w", () => {
    expect(stripWorktreeFlags("-w --verbose -w")).toBe("--verbose");
  });
});

describe("findNearestLiveTab", () => {
  const live = (id: string) => ({ ...makeSession({ id }), state: "idle" as const });
  const dead = (id: string) => ({ ...makeSession({ id }), state: "dead" as const });

  it("returns null for empty array", () => {
    expect(findNearestLiveTab([], 0)).toBeNull();
  });

  it("returns the only live tab", () => {
    expect(findNearestLiveTab([live("a")], 0)).toBe("a");
  });

  it("prefers the tab at fromIndex (right bias)", () => {
    const sessions = [live("a"), live("b"), live("c")];
    expect(findNearestLiveTab(sessions, 1)).toBe("b");
  });

  it("skips dead tabs and finds live tab to the right", () => {
    const sessions = [dead("a"), dead("b"), live("c")];
    expect(findNearestLiveTab(sessions, 0)).toBe("c");
  });

  it("skips dead tabs and finds live tab to the left", () => {
    const sessions = [live("a"), dead("b"), dead("c")];
    expect(findNearestLiveTab(sessions, 2)).toBe("a");
  });

  it("checks left at same distance when right is dead", () => {
    const sessions = [live("a"), dead("b"), live("c")];
    // fromIndex=1: dist=0 → right=1 (dead), left=0 (live "a") → returns "a"
    expect(findNearestLiveTab(sessions, 1)).toBe("a");
  });

  it("returns null when all are dead", () => {
    const sessions = [dead("a"), dead("b"), dead("c")];
    expect(findNearestLiveTab(sessions, 1)).toBeNull();
  });

  it("returns null when fromIndex is past end and all tabs are dead", () => {
    const sessions = [dead("a"), dead("b")];
    expect(findNearestLiveTab(sessions, 2)).toBeNull();
  });

  it("returns null for a single dead tab", () => {
    expect(findNearestLiveTab([dead("a")], 0)).toBeNull();
  });

  it("finds nearest live in mixed array", () => {
    const sessions = [dead("a"), dead("b"), live("c"), dead("d"), dead("e")];
    expect(findNearestLiveTab(sessions, 3)).toBe("c");
  });
});

describe("toolCategoryColor", () => {
  it("returns mapped color for known tool (Bash)", () => {
    expect(toolCategoryColor("Bash")).toBe("var(--warning)");
  });

  it("returns mapped color for known tool (Read)", () => {
    expect(toolCategoryColor("Read")).toBe("var(--accent)");
  });

  it("returns mapped color for known tool (Agent)", () => {
    expect(toolCategoryColor("Agent")).toBe("var(--accent-secondary)");
  });

  it("returns muted fallback for unknown/MCP tools", () => {
    expect(toolCategoryColor("mcp_custom_tool")).toBe("var(--text-muted)");
  });

  it("returns muted fallback for empty string", () => {
    expect(toolCategoryColor("")).toBe("var(--text-muted)");
  });

  it("every key in TOOL_COLORS returns its mapped value", () => {
    for (const [tool, color] of Object.entries(TOOL_COLORS)) {
      expect(toolCategoryColor(tool)).toBe(color);
    }
  });
});

describe("getActivityText", () => {
  it("returns null for null inputs", () => {
    expect(getActivityText(null)).toBeNull();
    expect(getActivityText(null, null)).toBeNull();
  });

  it("returns currentEventKind when both are provided", () => {
    expect(getActivityText("Bash", "ToolCallStart")).toBe("ToolCallStart");
  });

  it("falls back to currentToolName when eventKind is null", () => {
    expect(getActivityText("Bash", null)).toBe("Bash");
    expect(getActivityText("Bash")).toBe("Bash");
  });

  it("returns currentEventKind when toolName is null", () => {
    expect(getActivityText(null, "ThinkingStart")).toBe("ThinkingStart");
  });

  it("filters noisy event kinds", () => {
    expect(getActivityText(null, "CodexTokenCount", new Set(["CodexTokenCount"]))).toBeNull();
    expect(getActivityText("Bash", "CodexTokenCount", new Set(["CodexTokenCount"]))).toBe("Bash");
  });
});

describe("eventKindColor", () => {
  it("returns mapped color for known event kind", () => {
    expect(eventKindColor("ToolCallStart")).toBe(EVENT_KIND_COLORS["ToolCallStart"]);
  });

  it("returns mapped colors for Codex event kinds", () => {
    expect(eventKindColor("CodexTaskStarted")).toBe(EVENT_KIND_COLORS["CodexTaskStarted"]);
    expect(eventKindColor("CodexTaskComplete")).toBe(EVENT_KIND_COLORS["CodexTaskComplete"]);
    expect(eventKindColor("CodexTokenCount")).toBe(EVENT_KIND_COLORS["CodexTokenCount"]);
    expect(eventKindColor("CodexToolCallComplete")).toBe(EVENT_KIND_COLORS["CodexToolCallComplete"]);
    expect(eventKindColor("CodexTurnContext")).toBe(EVENT_KIND_COLORS["CodexTurnContext"]);
  });

  it("returns muted fallback for unknown event kind", () => {
    expect(eventKindColor("SomeUnknownEvent")).toBe("var(--text-muted)");
  });
});

describe("getActivityColor", () => {
  it("uses event colors before tool colors", () => {
    expect(getActivityColor("Bash", "ToolCallStart")).toBe(EVENT_KIND_COLORS["ToolCallStart"]);
  });

  it("uses tool colors when the event is noisy", () => {
    expect(getActivityColor("Bash", "CodexTokenCount", new Set(["CodexTokenCount"]))).toBe(TOOL_COLORS.Bash);
  });
});
