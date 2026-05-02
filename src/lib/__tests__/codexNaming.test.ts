import { describe, expect, it } from "vitest";
import {
  codexDefaultTabNameCandidates,
  deriveCodexPromptTitle,
  isAutoNameableCodexName,
} from "../codexNaming";

describe("deriveCodexPromptTitle", () => {
  it("derives a short title from a normal prompt", () => {
    expect(deriveCodexPromptTitle("Fix the Codex tab renaming bug in settings")).toBe(
      "Fix the Codex tab renaming bug in",
    );
  });

  it("ignores slash commands", () => {
    expect(deriveCodexPromptTitle("/rename better title")).toBeNull();
  });
});

describe("codexDefaultTabNameCandidates", () => {
  it("includes workingDir and launchWorkingDir basenames", () => {
    expect(codexDefaultTabNameCandidates(
      "/home/jordan/Desktop/Projects/ato-mcp",
      "/home/jordan/Desktop",
    )).toEqual(["ato-mcp", "Desktop"]);
  });

  it("deduplicates matching basenames", () => {
    expect(codexDefaultTabNameCandidates("/repo/app", "/tmp/app")).toEqual(["app"]);
  });
});

describe("isAutoNameableCodexName", () => {
  it("allows the working directory default name even when launchWorkingDir differs", () => {
    const defaults = codexDefaultTabNameCandidates(
      "/home/jordan/Desktop/Projects/ato-mcp",
      "/home/jordan/Desktop",
    );
    expect(isAutoNameableCodexName("ato-mcp", defaults)).toBe(true);
  });

  it("allows generic starter names", () => {
    expect(isAutoNameableCodexName("New Session", [])).toBe(true);
    expect(isAutoNameableCodexName("codex", [])).toBe(true);
    expect(isAutoNameableCodexName("run", [])).toBe(true);
  });

  it("preserves manual names", () => {
    expect(isAutoNameableCodexName("important investigation", ["ato-mcp", "Desktop"])).toBe(false);
  });
});
