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
  useSessionStore: { getState: () => ({ claudePath: null, codexPath: null }) },
}));

// Mock theme (used by useTerminal)
vi.mock("../../lib/theme", () => ({
  getTerminalTheme: () => ({}),
}));

// Mock debugLog
vi.mock("../../lib/debugLog", () => ({
  dlog: () => {},
  setDebugCaptureEnabled: () => {},
  setDebugCaptureResolver: () => {},
}));

import { getTerminalKeySequenceOverride, SHIFT_ENTER_SEQUENCE, TERMINAL_FONT_FAMILY } from "../useTerminal";

describe("TERMINAL_FONT_FAMILY", () => {
  it("is the default monospace stack", () => {
    expect(TERMINAL_FONT_FAMILY).toBe("'Pragmasevka', 'Roboto Mono', 'ClaudeEmoji', monospace");
  });
});

function keyEvent(overrides: Partial<KeyboardEvent>): Pick<KeyboardEvent, "type" | "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"> {
  return {
    type: "keydown",
    key: "",
    code: "",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("getTerminalKeySequenceOverride", () => {
  it("translates Shift+Enter to Claude Code's CSI-u shifted return sequence", () => {
    expect(getTerminalKeySequenceOverride(keyEvent({
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    }))).toBe(SHIFT_ENTER_SEQUENCE);
  });

  it("translates Shift+NumpadEnter", () => {
    expect(getTerminalKeySequenceOverride(keyEvent({
      key: "Enter",
      code: "NumpadEnter",
      shiftKey: true,
    }))).toBe(SHIFT_ENTER_SEQUENCE);
  });

  it("leaves plain Enter for xterm.js to handle normally", () => {
    expect(getTerminalKeySequenceOverride(keyEvent({
      key: "Enter",
      code: "Enter",
    }))).toBeNull();
  });

  it("does not override Ctrl/Alt/Meta modified Enter chords", () => {
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
      expect(getTerminalKeySequenceOverride(keyEvent({
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        [modifier]: true,
      }))).toBeNull();
    }
  });

  it("ignores keyup events", () => {
    expect(getTerminalKeySequenceOverride(keyEvent({
      type: "keyup",
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    }))).toBeNull();
  });
});
