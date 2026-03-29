import { describe, it, expect, vi } from "vitest";

// Mock Tauri IPC
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock paths (normalizePath used transitively)
vi.mock("../../lib/paths", () => ({
  normalizePath: (p: string) => p,
}));

// Mock sessions store (settings imports it)
vi.mock("../sessions", () => ({
  useSessionStore: { getState: () => ({ claudePath: null }) },
}));

// Mock settings store — we only test pure functions, not the store itself
vi.mock("../settings", () => ({
  useSettingsStore: { getState: () => ({ terminalFont: "default" }) },
}));

// Mock theme (used by useTerminal)
vi.mock("../../lib/theme", () => ({
  getXtermTheme: () => ({}),
}));

// Mock debugLog
vi.mock("../../lib/debugLog", () => ({
  dlog: () => {},
}));

import { TERMINAL_FONTS, resolveFont } from "../useTerminal";

describe("resolveFont", () => {
  it("returns default family for 'default' id", () => {
    expect(resolveFont("default")).toBe("'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace");
  });

  it("returns pragmasevka family for 'pragmasevka' id", () => {
    expect(resolveFont("pragmasevka")).toBe("'Pragmasevka', 'Cascadia Code', 'Fira Code', monospace");
  });

  it("falls back to default for unknown id", () => {
    expect(resolveFont("nonexistent")).toBe("'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace");
  });

  it("falls back to default for empty string", () => {
    expect(resolveFont("")).toBe("'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace");
  });
});

describe("TERMINAL_FONTS", () => {
  it("has 'default' as first entry (resolveFont fallback depends on this)", () => {
    expect(TERMINAL_FONTS[0].id).toBe("default");
  });

  it("every entry has id, label, and family", () => {
    for (const f of TERMINAL_FONTS) {
      expect(f.id).toBeTruthy();
      expect(f.label).toBeTruthy();
      expect(f.family).toBeTruthy();
    }
  });
});
