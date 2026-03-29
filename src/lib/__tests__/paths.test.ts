import { describe, it, expect } from "vitest";
import {
  normalizePath,
  abbreviatePath,
  formatScopePath,
  groupSessionsByDir,
  swapWithinGroup,
  parseWorktreePath,
  worktreeAcronym,
  dirToTabName,
  IS_WINDOWS,
} from "../paths";
// TabGroup type used implicitly via groupSessionsByDir return
import { scopePath } from "../../components/ConfigManager/ThreePaneEditor";
import type { TabId } from "../../components/ConfigManager/ThreePaneEditor";

// ── normalizePath ───────────────────────────────────────────────

describe("normalizePath", () => {
  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  describe.runIf(IS_WINDOWS)("Windows", () => {
    it("converts forward slashes to backslashes", () => {
      expect(normalizePath("C:/Users/jorda/code")).toBe("C:\\Users\\jorda\\code");
    });

    it("strips trailing backslash", () => {
      expect(normalizePath("C:\\Users\\jorda\\")).toBe("C:\\Users\\jorda");
    });

    it("strips multiple trailing backslashes", () => {
      expect(normalizePath("C:\\Users\\jorda\\\\")).toBe("C:\\Users\\jorda");
    });

    it("handles already-normalized path", () => {
      expect(normalizePath("C:\\Users\\jorda")).toBe("C:\\Users\\jorda");
    });
  });

  describe.runIf(!IS_WINDOWS)("Linux", () => {
    it("preserves forward slashes", () => {
      expect(normalizePath("/home/user/code")).toBe("/home/user/code");
    });

    it("strips trailing forward slash", () => {
      expect(normalizePath("/home/user/code/")).toBe("/home/user/code");
    });

    it("strips multiple trailing forward slashes", () => {
      expect(normalizePath("/home/user/code//")).toBe("/home/user/code");
    });

    it("handles already-clean path", () => {
      expect(normalizePath("/home/user/code")).toBe("/home/user/code");
    });

    it("does not convert backslashes to forward slashes", () => {
      expect(normalizePath("/home/user/my\\dir")).toBe("/home/user/my\\dir");
    });
  });
});

// ── abbreviatePath ──────────────────────────────────────────────

describe("abbreviatePath", () => {
  it("keeps last two components for long paths", () => {
    expect(abbreviatePath("C:/Users/jorda/Projects/my-app")).toBe("~/Projects/my-app");
  });

  it("handles backslash paths", () => {
    expect(abbreviatePath("C:\\Users\\jorda\\Desktop\\project")).toBe("~/Desktop/project");
  });

  it("returns full path when only two components", () => {
    expect(abbreviatePath("C:/code")).toBe("C:/code");
  });

  it("returns full path when one component", () => {
    expect(abbreviatePath("code")).toBe("code");
  });

  it("handles trailing slashes (filtered by split)", () => {
    expect(abbreviatePath("C:/Users/jorda/code/")).toBe("~/jorda/code");
  });

  it("handles deeply nested paths", () => {
    expect(abbreviatePath("C:/Users/jorda/Projects/work/client/app")).toBe("~/client/app");
  });
});

// ── formatScopePath ─────────────────────────────────────────────

describe("formatScopePath", () => {
  it("passes through user-scope paths (~/...) unchanged", () => {
    expect(formatScopePath("~/.claude/settings.json")).toBe("~/.claude/settings.json");
  });

  it("passes through ~/... paths with deeper nesting", () => {
    expect(formatScopePath("~/.claude/agents/")).toBe("~/.claude/agents/");
  });

  it("abbreviates project-scope paths with long directory prefix", () => {
    // dir portion = "C:/Users/jorda/Projects/my-app/.claude", file = "/settings.json"
    // abbreviatePath keeps last 2 dir components: "~/my-app/.claude"
    expect(formatScopePath("C:\\Users\\jorda\\Projects\\my-app/.claude/settings.json"))
      .toBe("~/my-app/.claude/settings.json");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(formatScopePath("C:\\Users\\jorda\\code\\CLAUDE.md"))
      .toBe("~/jorda/code/CLAUDE.md");
  });

  it("handles short paths (two or fewer components) without abbreviation", () => {
    expect(formatScopePath("project/CLAUDE.md")).toBe("project/CLAUDE.md");
  });

  it("handles single-segment path", () => {
    expect(formatScopePath("CLAUDE.md")).toBe("CLAUDE.md");
  });

  it("handles root-level slash only", () => {
    expect(formatScopePath("/")).toBe("/");
  });

  it("handles empty string", () => {
    expect(formatScopePath("")).toBe("");
  });
});

// ── scopePath (ThreePaneEditor) ─────────────────────────────────

describe("scopePath", () => {
  const dir = "C:\\Users\\jorda\\Projects\\my-app";

  describe("settings/hooks/plugins tabs share settings.json paths", () => {
    const settingsTabs: TabId[] = ["settings", "hooks", "plugins"];

    for (const tabId of settingsTabs) {
      it(`${tabId}: user scope`, () => {
        expect(scopePath("user", dir, tabId)).toBe("~/.claude/settings.json");
      });

      it(`${tabId}: project scope`, () => {
        expect(scopePath("project", dir, tabId)).toBe(`${dir}/.claude/settings.json`);
      });

      it(`${tabId}: project-local scope`, () => {
        expect(scopePath("project-local", dir, tabId)).toBe(`${dir}/.claude/settings.local.json`);
      });
    }
  });

  describe("claudemd tab", () => {
    it("user scope", () => {
      expect(scopePath("user", dir, "claudemd")).toBe("~/.claude/CLAUDE.md");
    });

    it("project scope — CLAUDE.md at project root", () => {
      expect(scopePath("project", dir, "claudemd")).toBe(`${dir}/CLAUDE.md`);
    });

    it("project-local scope — CLAUDE.md in .claude/", () => {
      expect(scopePath("project-local", dir, "claudemd")).toBe(`${dir}/.claude/CLAUDE.md`);
    });
  });

  describe("agents tab", () => {
    it("user scope", () => {
      expect(scopePath("user", dir, "agents")).toBe("~/.claude/agents/");
    });

    it("project scope", () => {
      expect(scopePath("project", dir, "agents")).toBe(`${dir}/.claude/agents/`);
    });

    it("project-local scope — uses local/ subdir", () => {
      expect(scopePath("project-local", dir, "agents")).toBe(`${dir}/.claude/local/agents/`);
    });
  });

  describe("empty dir fallback", () => {
    it("falls back to '.' when dir is empty", () => {
      expect(scopePath("project", "", "settings")).toBe("./.claude/settings.json");
    });

    it("falls back to '.' for claudemd", () => {
      expect(scopePath("project", "", "claudemd")).toBe("./CLAUDE.md");
    });

    it("falls back to '.' for agents", () => {
      expect(scopePath("project", "", "agents")).toBe("./.claude/agents/");
    });
  });
});

// ── parseWorktreePath ──────────────────────────────────────────

describe("parseWorktreePath", () => {
  it("detects a worktree path with backslashes", () => {
    const result = parseWorktreePath("C:\\Users\\jorda\\Projects\\claude_tabs\\.claude\\worktrees\\sorted-marinating-dove");
    expect(result).toEqual({
      projectName: "claude_tabs",
      worktreeName: "sorted-marinating-dove",
      projectRoot: "C:/Users/jorda/Projects/claude_tabs",
    });
  });

  it("detects a worktree path with forward slashes", () => {
    const result = parseWorktreePath("C:/Users/jorda/Projects/my-app/.claude/worktrees/fix-bug");
    expect(result).toEqual({
      projectName: "my-app",
      worktreeName: "fix-bug",
      projectRoot: "C:/Users/jorda/Projects/my-app",
    });
  });

  it("handles trailing slash", () => {
    const result = parseWorktreePath("C:/code/proj/.claude/worktrees/wt1/");
    expect(result).toEqual({
      projectName: "proj",
      worktreeName: "wt1",
      projectRoot: "C:/code/proj",
    });
  });

  it("returns null for non-worktree path", () => {
    expect(parseWorktreePath("C:\\Users\\jorda\\Projects\\claude_tabs")).toBeNull();
  });

  it("returns null for path containing .claude but not worktrees", () => {
    expect(parseWorktreePath("C:/code/proj/.claude/settings.json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseWorktreePath("")).toBeNull();
  });

  it("returns null for root-level .claude path (no project parent)", () => {
    expect(parseWorktreePath("/.claude/worktrees/wt1")).toBeNull();
  });
});

// ── worktreeAcronym ────────────────────────────────────────────

describe("worktreeAcronym", () => {
  it("creates acronym from hyphen-separated words", () => {
    expect(worktreeAcronym("sorted-marinating-dove")).toBe("SMD");
  });

  it("handles single word", () => {
    expect(worktreeAcronym("hotfix")).toBe("H");
  });

  it("handles two words", () => {
    expect(worktreeAcronym("fix-bug")).toBe("FB");
  });

  it("drops empty segments from consecutive hyphens", () => {
    expect(worktreeAcronym("a--b")).toBe("AB");
  });

  it("drops leading hyphen empty segment", () => {
    expect(worktreeAcronym("-foo")).toBe("F");
  });
});

// ── dirToTabName (worktree) ────────────────────────────────────

describe("dirToTabName", () => {
  it("returns project name for worktree path", () => {
    expect(dirToTabName("C:\\Users\\jorda\\Projects\\claude_tabs\\.claude\\worktrees\\sorted-marinating-dove")).toBe("claude_tabs");
  });

  it("returns last component for non-worktree path", () => {
    expect(dirToTabName("C:\\Users\\jorda\\Projects\\claude_tabs")).toBe("claude_tabs");
  });

  it("returns empty string for empty input", () => {
    expect(dirToTabName("")).toBe("");
  });
});

// ── Test helpers ────────────────────────────────────────────────

import type { Session } from "../../types/session";
import { DEFAULT_SESSION_CONFIG } from "../../types/session";

function mkSession(id: string, workingDir: string): Session {
  return {
    id,
    name: id,
    config: { ...DEFAULT_SESSION_CONFIG, workingDir },
    state: "idle",
    metadata: { costUsd: 0, contextPercent: 0, durationSecs: 0, currentAction: null, nodeSummary: null, currentToolName: null, inputTokens: 0, outputTokens: 0, assistantMessageCount: 0, choiceHint: false, runtimeModel: null, apiRegion: null, lastRequestId: null, subscriptionType: null, hookStatus: null, lastTurnCostUsd: 0, lastTurnTtftMs: 0, systemPromptLength: 0, toolCount: 0, conversationLength: 0, activeSubprocess: null, filesTouched: [], rateLimitRemaining: null, rateLimitReset: null, apiLatencyMs: null, linesAdded: 0, linesRemoved: 0, lastToolDurationMs: null, lastToolResultSize: null, lastToolError: null, apiRetryCount: 0, apiErrorStatus: null, apiRetryInfo: null, stallDurationMs: 0, stallCount: 0, contextBudget: null, hookTelemetry: null, planOutcome: null, effortLevel: null, worktreeInfo: null, capturedSystemPrompt: null, statusLine: null },
    createdAt: "",
    lastActive: "",
  };
}

// ── groupSessionsByDir ─────────────────────────────────────────

describe("groupSessionsByDir", () => {
  it("groups sessions with identical workingDir", () => {
    const sessions = [
      mkSession("a", "C:\\code\\proj"),
      mkSession("b", "C:\\code\\proj"),
      mkSession("c", "C:\\other"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["c"]);
  });

  it.runIf(IS_WINDOWS)("normalizes mixed slash styles into same group (Windows)", () => {
    const sessions = [
      mkSession("a", "C:/code/proj"),
      mkSession("b", "C:\\code\\proj"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });

  it("preserves relative order within groups", () => {
    const sessions = [
      mkSession("a1", "C:\\alpha"),
      mkSession("b1", "C:\\beta"),
      mkSession("a2", "C:\\alpha"),
      mkSession("b2", "C:\\beta"),
      mkSession("a3", "C:\\alpha"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a1", "a2", "a3"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["b1", "b2"]);
  });

  it("orders groups by first occurrence", () => {
    const sessions = [
      mkSession("b1", "C:\\beta"),
      mkSession("a1", "C:\\alpha"),
      mkSession("b2", "C:\\beta"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups[0].key).toBe("C:\\beta");
    expect(groups[1].key).toBe("C:\\alpha");
  });

  it("returns empty array for empty input", () => {
    expect(groupSessionsByDir([])).toEqual([]);
  });

  it("creates single-session groups", () => {
    const sessions = [mkSession("a", "C:\\one"), mkSession("b", "C:\\two")];
    const groups = groupSessionsByDir(sessions);
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions).toHaveLength(1);
    expect(groups[1].sessions).toHaveLength(1);
  });

  it("sets label from dirToTabName", () => {
    const groups = groupSessionsByDir([mkSession("a", "C:\\Users\\jorda\\my-project")]);
    expect(groups[0].label).toBe("my-project");
  });

  it("sets fullPath to original workingDir", () => {
    const groups = groupSessionsByDir([mkSession("a", "C:/foo/bar")]);
    expect(groups[0].fullPath).toBe("C:/foo/bar");
  });

  it("groups sessions with empty workingDir together", () => {
    const sessions = [
      mkSession("a", ""),
      mkSession("b", ""),
      mkSession("c", "C:\\code"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(groups[0].key).toBe("");
  });

  it("merges trailing-slash variant into same group", () => {
    const sessions = IS_WINDOWS
      ? [mkSession("a", "C:\\code\\proj\\"), mkSession("b", "C:\\code\\proj")]
      : [mkSession("a", "/code/proj/"), mkSession("b", "/code/proj")];
    const groups = groupSessionsByDir(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });

  it("treats different cases as separate groups (case-sensitive)", () => {
    // normalizePath does not lowercase; Windows paths differ by case
    const sessions = [
      mkSession("a", "C:\\Code"),
      mkSession("b", "C:\\code"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups).toHaveLength(2);
  });

  it.runIf(IS_WINDOWS)("uses first session's workingDir for fullPath when variants differ (Windows)", () => {
    // Forward-slash variant appears first; fullPath preserves that original form
    const sessions = [
      mkSession("a", "C:/code/proj"),
      mkSession("b", "C:\\code\\proj"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups[0].fullPath).toBe("C:/code/proj");
  });

  it("handles single session with empty workingDir", () => {
    const groups = groupSessionsByDir([mkSession("x", "")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("");
    expect(groups[0].label).toBe("");
    expect(groups[0].fullPath).toBe("");
  });

  it("groups worktree sessions with their project root", () => {
    const sessions = [
      mkSession("root", "C:\\Users\\jorda\\PycharmProjects\\claude_tabs"),
      mkSession("wt1", "C:\\Users\\jorda\\PycharmProjects\\claude_tabs\\.claude\\worktrees\\gentle-wandering-dongarra"),
      mkSession("wt2", "C:\\Users\\jorda\\PycharmProjects\\claude_tabs\\.claude\\worktrees\\sorted-marinating-dove"),
    ];
    const groups = groupSessionsByDir(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["root", "wt1", "wt2"]);
    expect(groups[0].label).toBe("claude_tabs");
    expect(groups[0].key).toBe("C:\\Users\\jorda\\PycharmProjects\\claude_tabs");
  });
});

// ── swapWithinGroup ────────────────────────────────────────────

describe("swapWithinGroup", () => {
  const sessions = [
    mkSession("a1", "C:\\alpha"),
    mkSession("a2", "C:\\alpha"),
    mkSession("a3", "C:\\alpha"),
    mkSession("b1", "C:\\beta"),
  ];
  const groups = groupSessionsByDir(sessions);
  const allIds = sessions.map((s) => s.id);

  it("swaps right within group", () => {
    const result = swapWithinGroup(allIds, "a1", "right", groups);
    expect(result).toEqual(["a2", "a1", "a3", "b1"]);
  });

  it("swaps left within group", () => {
    const result = swapWithinGroup(allIds, "a2", "left", groups);
    expect(result).toEqual(["a2", "a1", "a3", "b1"]);
  });

  it("returns null at left boundary", () => {
    expect(swapWithinGroup(allIds, "a1", "left", groups)).toBeNull();
  });

  it("returns null at right boundary", () => {
    expect(swapWithinGroup(allIds, "a3", "right", groups)).toBeNull();
  });

  it("returns null for single-session group", () => {
    expect(swapWithinGroup(allIds, "b1", "left", groups)).toBeNull();
    expect(swapWithinGroup(allIds, "b1", "right", groups)).toBeNull();
  });

  it("returns null for unknown target", () => {
    expect(swapWithinGroup(allIds, "unknown", "left", groups)).toBeNull();
  });

  it("does not mutate input array", () => {
    const copy = [...allIds];
    swapWithinGroup(allIds, "a1", "right", groups);
    expect(allIds).toEqual(copy);
  });

  it("swaps middle element right within group", () => {
    const result = swapWithinGroup(allIds, "a2", "right", groups);
    expect(result).toEqual(["a1", "a3", "a2", "b1"]);
  });

  it("swaps last element left within group", () => {
    const result = swapWithinGroup(allIds, "a3", "left", groups);
    expect(result).toEqual(["a1", "a3", "a2", "b1"]);
  });

  it("returns null when target exists in groups but not in allIds", () => {
    // Simulates stale allIds missing a session
    const staleIds = ["a1", "a3", "b1"]; // a2 missing from flat list
    expect(swapWithinGroup(staleIds, "a2", "right", groups)).toBeNull();
  });

  it("works with interleaved allIds ordering", () => {
    // allIds may be ordered differently than group-internal order
    const interleaved = ["b1", "a3", "a1", "a2"];
    const result = swapWithinGroup(interleaved, "a1", "right", groups);
    // a1 swaps with a2: positions in allIds swap
    expect(result).not.toBeNull();
    expect(result![result!.indexOf("a2")]).toBe("a2");
    expect(result![result!.indexOf("a1")]).toBe("a1");
    // The key invariant: a1 and a2 positions are swapped
    expect(result![interleaved.indexOf("a1")]).toBe("a2");
    expect(result![interleaved.indexOf("a2")]).toBe("a1");
  });

  it("returns null for empty allIds", () => {
    expect(swapWithinGroup([], "a1", "right", groups)).toBeNull();
  });

  it("returns null for empty groups array", () => {
    expect(swapWithinGroup(allIds, "a1", "right", [])).toBeNull();
  });
});
