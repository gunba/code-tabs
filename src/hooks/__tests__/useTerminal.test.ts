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

// Mock theme (used by useTerminal)
vi.mock("../../lib/theme", () => ({
  getTerminalTheme: () => ({}),
}));

// Mock debugLog
vi.mock("../../lib/debugLog", () => ({
  dlog: () => {},
  setDebugCaptureEnabled: () => {},
}));

import { TERMINAL_FONT_FAMILY } from "../useTerminal";

describe("TERMINAL_FONT_FAMILY", () => {
  it("is the default monospace stack", () => {
    expect(TERMINAL_FONT_FAMILY).toBe("'Pragmasevka', 'Roboto Mono', monospace");
  });
});
