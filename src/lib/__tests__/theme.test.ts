import { describe, it, expect } from "vitest";
import { CLAUDE_THEME } from "../theme";
import type { Theme } from "../theme";

describe("CLAUDE_THEME", () => {
  it("has all required color keys", () => {
    const required: (keyof Theme["colors"])[] = [
      "bgPrimary",
      "bgSurface",
      "bgSurfaceHover",
      "bgSelection",
      "border",
      "borderSubtle",
      "textPrimary",
      "textSecondary",
      "textMuted",
      "textOnAccent",
      "accent",
      "accentHover",
      "accentBg",
      "accentSecondary",
      "accentTertiary",
      "cliClaude",
      "cliClaudeBg",
      "cliCodex",
      "cliCodexBg",
      "success",
      "warning",
      "error",
      "info",
      "permission",
      "termBg",
      "termFg",
      "termCursor",
      "termSelection",
      "scrollThumb",
      "scrollTrack",
    ];

    for (const key of required) {
      expect(CLAUDE_THEME.colors[key]).toBeDefined();
      expect(CLAUDE_THEME.colors[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("has a name", () => {
    expect(CLAUDE_THEME.name).toBe("Claude");
  });

  it("accent color is Claude's Cowork clay", () => {
    expect(CLAUDE_THEME.colors.accent).toBe("#d4744a");
  });

  it("provider colors are centralized", () => {
    expect(CLAUDE_THEME.colors.cliClaude).toBe("#d4744a");
    expect(CLAUDE_THEME.colors.cliCodex).toBe("#39c5cf");
  });

  it("warm dark background (not blue-tinted)", () => {
    // Claude theme backgrounds should have warm (brownish) tones, not cold blue
    const bg = CLAUDE_THEME.colors.bgPrimary;
    const r = parseInt(bg.slice(1, 3), 16);
    const b = parseInt(bg.slice(5, 7), 16);
    // Red channel should be >= blue channel for warm tones
    expect(r).toBeGreaterThanOrEqual(b);
  });
});
