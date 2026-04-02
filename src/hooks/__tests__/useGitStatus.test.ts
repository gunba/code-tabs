import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock @tauri-apps/api/core ───────────────────────────────────────────

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// ── Mock diffParser ─────────────────────────────────────────────────────

const mockParseGitStatus = vi.fn();
const mockDetectChangedPaths = vi.fn();
vi.mock("../../lib/diffParser", () => ({
  parseGitStatus: (...args: unknown[]) => mockParseGitStatus(...args),
  detectChangedPaths: (...args: unknown[]) => mockDetectChangedPaths(...args),
}));

// ── React hooks mock ────────────────────────────────────────────────────

type EffectFn = () => (() => void) | void;

interface MockState {
  isGitRepo: boolean;
  status: unknown;
  error: string | null;
  changedPaths: Set<string>;
}

const state: MockState = {
  isGitRepo: false,
  status: null,
  error: null,
  changedPaths: new Set(),
};

// Allow dynamic key access for the mock useState
const stateRecord = state as unknown as Record<string, unknown>;

let effects: { fn: EffectFn; deps: unknown[] }[] = [];
let useStateCallIndex = 0;
let useRefCallIndex = 0;

// Order must match useState calls in hook source
const stateKeys = ["isGitRepo", "status", "error", "changedPaths"] as const;

let prevStatusRef: { current: unknown };
let cancelledRef: { current: boolean };

vi.mock("react", () => ({
  useState: (init: unknown) => {
    const key = stateKeys[useStateCallIndex % stateKeys.length];
    if (useStateCallIndex < stateKeys.length) {
      stateRecord[key] = init;
    }
    const setter = (v: unknown) => {
      stateRecord[key] = v;
    };
    useStateCallIndex++;
    return [stateRecord[key], setter];
  },
  useEffect: (fn: EffectFn, deps?: unknown[]) => {
    effects.push({ fn, deps: deps ?? [] });
  },
  useRef: (init: unknown) => {
    if (useRefCallIndex % 2 === 0) {
      prevStatusRef = { current: init };
      useRefCallIndex++;
      return prevStatusRef;
    } else {
      cancelledRef = { current: init as boolean };
      useRefCallIndex++;
      return cancelledRef;
    }
  },
}));

import { useGitStatus } from "../useGitStatus";
import type { GitStatusData, GitStatusRaw } from "../../types/git";

// ── Helpers ─────────────────────────────────────────────────────────────

function resetMockState() {
  state.isGitRepo = false;
  state.status = null;
  state.error = null;
  state.changedPaths = new Set();
  effects = [];
  useStateCallIndex = 0;
  useRefCallIndex = 0;
}

function makeStatusData(overrides?: Partial<GitStatusData>): GitStatusData {
  return {
    staged: [],
    unstaged: [],
    untracked: [],
    branch: "main",
    totalInsertions: 0,
    totalDeletions: 0,
    ...overrides,
  };
}

function makeRawStatus(): GitStatusRaw {
  return {
    porcelain: "## main\n M file.ts",
    numstat: "1\t0\tfile.ts",
    numstatStaged: "",
  };
}

/**
 * Establish isGitRepo=true via the repo check effect, then prepare
 * for a second useGitStatus call with fresh effects and preserved state.
 */
async function establishRepoAndReinvoke(workingDir: string) {
  mockInvoke.mockResolvedValueOnce(true);
  useGitStatus(workingDir, true);
  effects[0].fn();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.isGitRepo).toBe(true);

  effects = [];
  useStateCallIndex = stateKeys.length; // preserve state across re-render
  useRefCallIndex = 0;

  useGitStatus(workingDir, true);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("useGitStatus", () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDetectChangedPaths.mockReturnValue(new Set());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("initial state", () => {
    it("returns correct defaults", () => {
      const result = useGitStatus("/some/dir", true);
      expect(result.isGitRepo).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toBeNull();
      expect(result.changedPaths).toEqual(new Set());
    });

    it("registers two effects (repo check + poll)", () => {
      useGitStatus("/some/dir", true);
      expect(effects).toHaveLength(2);
    });
  });

  describe("repo check effect (first effect)", () => {
    it("calls git_repo_check with workingDir", async () => {
      mockInvoke.mockResolvedValueOnce(true);
      useGitStatus("/project", true);
      effects[0].fn();
      await vi.runAllTimersAsync();

      expect(mockInvoke).toHaveBeenCalledWith("git_repo_check", {
        workingDir: "/project",
      });
    });

    it("sets isGitRepo=true when repo check succeeds", async () => {
      mockInvoke.mockResolvedValueOnce(true);
      useGitStatus("/project", true);
      effects[0].fn();
      await vi.runAllTimersAsync();

      expect(state.isGitRepo).toBe(true);
    });

    it("sets isGitRepo=false and status=null when repo check returns false", async () => {
      mockInvoke.mockResolvedValueOnce(false);
      useGitStatus("/project", true);
      effects[0].fn();
      await vi.runAllTimersAsync();

      expect(state.isGitRepo).toBe(false);
      expect(state.status).toBeNull();
    });

    it("sets error on repo check failure", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("git not found"));
      useGitStatus("/project", true);
      effects[0].fn();
      await vi.runAllTimersAsync();

      expect(state.isGitRepo).toBe(false);
      expect(state.status).toBeNull();
      expect(state.error).toBe("Error: git not found");
    });

    it("does not update state if cancelled before resolve", async () => {
      let resolveInvoke!: (v: boolean) => void;
      mockInvoke.mockReturnValueOnce(
        new Promise<boolean>((r) => { resolveInvoke = r; }),
      );
      useGitStatus("/project", true);

      const cleanup = effects[0].fn();
      if (typeof cleanup === "function") cleanup();
      resolveInvoke(true);
      await vi.runAllTimersAsync();

      expect(state.isGitRepo).toBe(false);
    });

    it("resets error and changedPaths immediately but keeps isGitRepo (GS-01)", async () => {
      mockInvoke.mockResolvedValueOnce(true);
      useGitStatus("/project-a", true);
      effects[0].fn();
      await vi.runAllTimersAsync();
      expect(state.isGitRepo).toBe(true);

      // Simulate workingDir change (re-render)
      effects = [];
      useStateCallIndex = stateKeys.length;
      useRefCallIndex = 0;

      mockInvoke.mockResolvedValueOnce(true);
      useGitStatus("/project-b", true);
      effects[0].fn();

      // isGitRepo preserved during the async transition
      expect(state.isGitRepo).toBe(true);
      expect(state.error).toBeNull();
      expect(state.changedPaths).toEqual(new Set());
    });
  });

  describe("disabled / null workingDir", () => {
    it("sets isGitRepo=false and status=null when workingDir is null", () => {
      useGitStatus(null, true);
      effects[0].fn();
      expect(state.isGitRepo).toBe(false);
      expect(state.status).toBeNull();
    });

    it("sets isGitRepo=false and status=null when enabled=false", () => {
      useGitStatus("/project", false);
      effects[0].fn();
      expect(state.isGitRepo).toBe(false);
      expect(state.status).toBeNull();
    });

    it("does not call invoke when disabled", () => {
      useGitStatus("/project", false);
      effects[0].fn();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("does not call invoke when workingDir is null", () => {
      useGitStatus(null, true);
      effects[0].fn();
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("polling effect (second effect)", () => {
    it("does not poll when isGitRepo is false", () => {
      useGitStatus("/project", true);
      const result = effects[1].fn();
      expect(result).toBeUndefined();
      expect(mockInvoke).not.toHaveBeenCalledWith("git_status", expect.anything());
    });

    it("polls git_status when isGitRepo is true", async () => {
      await establishRepoAndReinvoke("/project");

      expect(effects[1].deps).toEqual(["/project", true, true]);

      const parsed = makeStatusData();
      mockInvoke.mockResolvedValueOnce(makeRawStatus());
      mockParseGitStatus.mockReturnValueOnce(parsed);
      mockDetectChangedPaths.mockReturnValueOnce(new Set());

      const cleanup = effects[1].fn();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledWith("git_status", { workingDir: "/project" });
      expect(mockParseGitStatus).toHaveBeenCalled();
      expect(state.status).toEqual(parsed);

      expect(typeof cleanup).toBe("function");
      if (typeof cleanup === "function") cleanup();
    });

    it("schedules next poll after POLL_INTERVAL (2s)", async () => {
      await establishRepoAndReinvoke("/project");

      const parsed = makeStatusData();
      mockInvoke.mockResolvedValueOnce(makeRawStatus());
      mockParseGitStatus.mockReturnValueOnce(parsed);
      mockDetectChangedPaths.mockReturnValueOnce(new Set());

      mockInvoke.mockResolvedValueOnce(makeRawStatus());
      mockParseGitStatus.mockReturnValueOnce(parsed);
      mockDetectChangedPaths.mockReturnValueOnce(new Set());

      const cleanup = effects[1].fn();
      await vi.advanceTimersByTimeAsync(0);

      const firstCalls = mockInvoke.mock.calls.filter(
        (c: unknown[]) => c[0] === "git_status",
      );
      expect(firstCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2000);

      const allCalls = mockInvoke.mock.calls.filter(
        (c: unknown[]) => c[0] === "git_status",
      );
      expect(allCalls).toHaveLength(2);

      if (typeof cleanup === "function") cleanup();
    });

    it("cleanup prevents further polling", async () => {
      await establishRepoAndReinvoke("/project");

      mockInvoke.mockResolvedValueOnce(makeRawStatus());
      mockParseGitStatus.mockReturnValueOnce(makeStatusData());
      mockDetectChangedPaths.mockReturnValueOnce(new Set());

      const cleanup = effects[1].fn();
      if (typeof cleanup === "function") cleanup();

      expect(cancelledRef.current).toBe(true);
    });

    it("sets error on poll failure", async () => {
      await establishRepoAndReinvoke("/project");

      mockInvoke.mockRejectedValueOnce(new Error("git status failed"));

      const cleanup = effects[1].fn();
      await vi.advanceTimersByTimeAsync(0);

      expect(state.error).toBe("Error: git status failed");

      if (typeof cleanup === "function") cleanup();
    });

    it("sets changedPaths when changes detected and clears after animation", async () => {
      await establishRepoAndReinvoke("/project");

      const parsed = makeStatusData();
      const changedSet = new Set(["u:file.ts"]);
      mockInvoke.mockResolvedValueOnce(makeRawStatus());
      mockParseGitStatus.mockReturnValueOnce(parsed);
      mockDetectChangedPaths.mockReturnValueOnce(changedSet);

      // Subsequent polls return no changes
      mockInvoke.mockResolvedValue(makeRawStatus());
      mockParseGitStatus.mockReturnValue(parsed);
      mockDetectChangedPaths.mockReturnValue(new Set());

      const cleanup = effects[1].fn();
      await vi.advanceTimersByTimeAsync(0);

      expect(state.changedPaths).toEqual(changedSet);

      // ANIMATION_DURATION = 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      expect(state.changedPaths).toEqual(new Set());

      if (typeof cleanup === "function") cleanup();
    });
  });

  describe("visibility during tab switch (GS-01)", () => {
    it("isGitRepo is not reset synchronously when workingDir changes", async () => {
      mockInvoke.mockResolvedValueOnce(true);
      useGitStatus("/project-a", true);
      effects[0].fn();
      await vi.runAllTimersAsync();
      expect(state.isGitRepo).toBe(true);

      effects = [];
      useStateCallIndex = stateKeys.length;
      useRefCallIndex = 0;

      let resolveCheck!: (v: boolean) => void;
      mockInvoke.mockReturnValueOnce(
        new Promise<boolean>((r) => { resolveCheck = r; }),
      );
      useGitStatus("/project-b", true);
      effects[0].fn();

      // isGitRepo stays true during the async round-trip (GS-01)
      expect(state.isGitRepo).toBe(true);
      expect(state.error).toBeNull();
      expect(state.changedPaths).toEqual(new Set());

      resolveCheck(true);
      await vi.runAllTimersAsync();
      expect(state.isGitRepo).toBe(true);
    });

    it("isGitRepo resets when workingDir becomes null", () => {
      useGitStatus(null, true);
      effects[0].fn();
      expect(state.isGitRepo).toBe(false);
      expect(state.status).toBeNull();
    });

    it("isGitRepo resets when enabled becomes false", () => {
      useGitStatus("/project", false);
      effects[0].fn();
      expect(state.isGitRepo).toBe(false);
      expect(state.status).toBeNull();
    });

    it("isGitRepo resets when new dir is not a git repo", async () => {
      mockInvoke.mockResolvedValueOnce(true);
      useGitStatus("/project-a", true);
      effects[0].fn();
      await vi.runAllTimersAsync();
      expect(state.isGitRepo).toBe(true);

      effects = [];
      useStateCallIndex = stateKeys.length;
      useRefCallIndex = 0;
      mockInvoke.mockResolvedValueOnce(false);
      useGitStatus("/not-a-repo", true);
      effects[0].fn();
      await vi.runAllTimersAsync();

      expect(state.isGitRepo).toBe(false);
      expect(state.status).toBeNull();
    });
  });

  describe("effect dependencies", () => {
    it("repo check effect depends on [workingDir, enabled]", () => {
      useGitStatus("/dir", true);
      expect(effects[0].deps).toEqual(["/dir", true]);
    });

    it("poll effect depends on [workingDir, enabled, isGitRepo]", () => {
      useGitStatus("/dir", true);
      expect(effects[1].deps).toEqual(["/dir", true, false]);
    });

    it("poll effect reflects isGitRepo=true after repo check", async () => {
      await establishRepoAndReinvoke("/dir");
      expect(effects[1].deps).toEqual(["/dir", true, true]);
    });
  });

  describe("return type", () => {
    it("returns all four fields", () => {
      const result = useGitStatus("/dir", true);
      expect(result).toHaveProperty("isGitRepo");
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("error");
      expect(result).toHaveProperty("changedPaths");
    });

    it("changedPaths is a Set", () => {
      const result = useGitStatus("/dir", true);
      expect(result.changedPaths).toBeInstanceOf(Set);
    });
  });
});
