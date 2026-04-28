import { describe, expect, it } from "vitest";
import {
  classifyTerminalKey,
  isTerminalModalOpen,
  SHIFT_ENTER_SEQUENCE,
  type TerminalKeyEventLike,
} from "../terminalKeyShortcuts";

function keyEvent(overrides: Partial<TerminalKeyEventLike>): TerminalKeyEventLike {
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

function classify(overrides: Partial<TerminalKeyEventLike>, ctx = {}) {
  return classifyTerminalKey(keyEvent(overrides), {
    isLinux: false,
    modalOpen: false,
    hasSelection: false,
    ...ctx,
  });
}

describe("classifyTerminalKey", () => {
  it("sends Shift+Enter as the kitty shifted-return sequence", () => {
    expect(classify({ key: "Enter", code: "Enter", shiftKey: true })).toEqual({
      kind: "send",
      data: SHIFT_ENTER_SEQUENCE,
    });
  });

  it("swallows all input while a modal is open", () => {
    expect(classify({ key: "a" }, { modalOpen: true })).toEqual({ kind: "swallow" });
  });

  it("copies only when Ctrl+C has a selection", () => {
    expect(classify({ key: "c", ctrlKey: true }, { hasSelection: true })).toEqual({
      kind: "action",
      action: "copySelection",
    });
    expect(classify({ key: "c", ctrlKey: true }, { hasSelection: false })).toEqual({ kind: "passthrough" });
  });

  it("always handles Ctrl+Shift+C as copySelection", () => {
    expect(classify({ key: "C", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "action",
      action: "copySelection",
    });
  });

  it("handles paste chords with the Linux Ctrl+V passthrough exception", () => {
    expect(classify({ key: "V", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "action",
      action: "pasteClipboard",
    });
    expect(classify({ key: "v", ctrlKey: true })).toEqual({
      kind: "action",
      action: "pasteClipboard",
    });
    expect(classify({ key: "v", ctrlKey: true }, { isLinux: true })).toEqual({ kind: "passthrough" });
  });

  it("turns terminal scroll chords into actions", () => {
    expect(classify({ key: "Home", ctrlKey: true })).toEqual({ kind: "action", action: "scrollTop" });
    expect(classify({ key: "End", ctrlKey: true })).toEqual({ kind: "action", action: "scrollBottom" });
  });

  it("swallows app-level shortcuts that xterm would otherwise consume", () => {
    expect(classify({ key: "1", altKey: true })).toEqual({ kind: "swallow" });
    expect(classify({ key: "t", ctrlKey: true })).toEqual({ kind: "swallow" });
    expect(classify({ key: "Tab", ctrlKey: true })).toEqual({ kind: "swallow" });
    expect(classify({ key: "F", ctrlKey: true, shiftKey: true })).toEqual({ kind: "swallow" });
    expect(classify({ key: "Escape" })).toEqual({ kind: "swallow" });
  });
});

describe("isTerminalModalOpen", () => {
  it("detects the modal overlay data attribute", () => {
    expect(isTerminalModalOpen({
      querySelector: (selector: string) => selector.includes("[data-modal-overlay]") ? ({} as Element) : null,
    })).toBe(true);
  });

  it("keeps legacy modal class selectors during transition", () => {
    expect(isTerminalModalOpen({
      querySelector: (selector: string) => selector.includes(".palette-overlay") ? ({} as Element) : null,
    })).toBe(true);
  });
});
