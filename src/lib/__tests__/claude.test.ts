import { describe, it, expect, beforeEach } from "vitest";
import {
  dirToTabName,
  modelLabel,
  formatTokenCount,
  SESSION_COLORS,
  assignSessionColor,
  sessionColor,
  releaseSessionColor,
  getSessionColorIndex,
  forceSessionColor,
} from "../claude";

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

describe("formatTokenCount", () => {
  it("returns raw number for small values", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("returns <1 for zero", () => {
    expect(formatTokenCount(0)).toBe("<1");
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
});
