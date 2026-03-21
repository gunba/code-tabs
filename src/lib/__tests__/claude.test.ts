import { describe, it, expect, beforeEach } from "vitest";
import {
  dirToTabName,
  modelLabel,
  modelColor,
  formatTokenCount,
  computeHeatLevel,
  getHeatStyle,
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

describe("modelColor", () => {
  it("returns muted color for null", () => {
    expect(modelColor(null)).toBe("var(--text-muted)");
  });

  it("returns tertiary accent for opus model", () => {
    expect(modelColor("claude-opus-4-6")).toBe("var(--accent-tertiary)");
  });

  it("returns secondary accent for sonnet model", () => {
    expect(modelColor("claude-sonnet-4-6")).toBe("var(--accent-secondary)");
  });

  it("returns success color for haiku model", () => {
    expect(modelColor("claude-haiku-4-5-20251001")).toBe("var(--success)");
  });

  it("returns muted color for unknown model", () => {
    expect(modelColor("custom-model-v1")).toBe("var(--text-muted)");
  });

  it("matches opus substring anywhere in model string", () => {
    expect(modelColor("some-opus-variant")).toBe("var(--accent-tertiary)");
  });

  it("matches sonnet substring anywhere in model string", () => {
    expect(modelColor("my-sonnet-4-20260101")).toBe("var(--accent-secondary)");
  });

  it("matches haiku substring anywhere in model string", () => {
    expect(modelColor("claude-3-haiku-20240307")).toBe("var(--success)");
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

describe("computeHeatLevel", () => {
  it("returns 0 for zero count", () => {
    expect(computeHeatLevel(0, 10)).toBe(0);
  });

  it("returns 0 when maxCount is 0", () => {
    expect(computeHeatLevel(5, 0)).toBe(0);
  });

  it("returns 1 for low usage (<25%)", () => {
    expect(computeHeatLevel(2, 10)).toBe(1);
    expect(computeHeatLevel(1, 10)).toBe(1);
  });

  it("returns 2 for mid usage (25%-69%)", () => {
    expect(computeHeatLevel(3, 10)).toBe(2);
    expect(computeHeatLevel(5, 10)).toBe(2);
    expect(computeHeatLevel(6, 10)).toBe(2);
  });

  it("returns 3 for high usage (>=70%)", () => {
    expect(computeHeatLevel(7, 10)).toBe(3);
    expect(computeHeatLevel(10, 10)).toBe(3);
  });

  it("returns 3 when count equals maxCount", () => {
    expect(computeHeatLevel(1, 1)).toBe(3);
  });

  it("returns 0 for negative count", () => {
    expect(computeHeatLevel(-1, 10)).toBe(0);
  });

  it("boundary: exactly 25% returns 2", () => {
    expect(computeHeatLevel(25, 100)).toBe(2);
  });

  it("boundary: exactly 70% returns 3", () => {
    expect(computeHeatLevel(70, 100)).toBe(3);
  });

  it("returns 0 for negative maxCount", () => {
    expect(computeHeatLevel(5, -1)).toBe(0);
  });

  it("returns 3 when count exceeds maxCount", () => {
    expect(computeHeatLevel(15, 10)).toBe(3);
  });

  it("boundary: just below 25% returns 1", () => {
    expect(computeHeatLevel(24, 100)).toBe(1);
  });

  it("boundary: just below 70% returns 2", () => {
    expect(computeHeatLevel(69, 100)).toBe(2);
  });
});

describe("getHeatStyle", () => {
  it("returns empty object for level 0", () => {
    expect(getHeatStyle(0)).toEqual({});
  });

  it("returns color-mix styles for level 1", () => {
    const style = getHeatStyle(1);
    expect(style.color).toContain("color-mix");
    expect(style.color).toContain("30%");
  });

  it("returns stronger styles for level 2", () => {
    const style = getHeatStyle(2);
    expect(style.color).toContain("65%");
    expect(style.borderColor).toContain("color-mix");
  });

  it("returns full accent styles for level 3", () => {
    const style = getHeatStyle(3);
    expect(style.color).toBe("var(--accent)");
    expect(style.background).toBe("var(--accent-bg)");
    expect(style.borderColor).toContain("color-mix");
    expect(style.borderColor).toContain("60%");
  });

  it("level 0 has no color, borderColor, or background", () => {
    const style = getHeatStyle(0);
    expect(Object.keys(style)).toHaveLength(0);
  });

  it("level 1 has borderColor set to plain border var", () => {
    const style = getHeatStyle(1);
    expect(style.borderColor).toBe("var(--border)");
    expect(style.background).toBeUndefined();
  });

  it("level 2 has no background property", () => {
    const style = getHeatStyle(2);
    expect(style.background).toBeUndefined();
  });

  it("level 3 is the only level with background", () => {
    expect(getHeatStyle(0).background).toBeUndefined();
    expect(getHeatStyle(1).background).toBeUndefined();
    expect(getHeatStyle(2).background).toBeUndefined();
    expect(getHeatStyle(3).background).toBe("var(--accent-bg)");
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
