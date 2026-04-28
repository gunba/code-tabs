export const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

export type TerminalKeyEventLike = Pick<KeyboardEvent, "type" | "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">;

export type TerminalAction =
  | "copySelection"
  | "pasteClipboard"
  | "scrollTop"
  | "scrollBottom";

export type TerminalKeyDecision =
  | { kind: "passthrough" }
  | { kind: "swallow" }
  | { kind: "send"; data: string }
  | { kind: "action"; action: TerminalAction };

export const TERMINAL_MODAL_SELECTOR =
  "[data-modal-overlay], .launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay, .inspector-overlay";

export function isTerminalModalOpen(root: Pick<Document, "querySelector"> = document): boolean {
  return root.querySelector(TERMINAL_MODAL_SELECTOR) !== null;
}

export function getTerminalKeySequenceOverride(ev: TerminalKeyEventLike): string | null {
  const isEnter = ev.key === "Enter" || ev.code === "Enter" || ev.code === "NumpadEnter";
  if (
    ev.type === "keydown" &&
    isEnter &&
    ev.shiftKey &&
    !ev.ctrlKey &&
    !ev.altKey &&
    !ev.metaKey
  ) {
    return SHIFT_ENTER_SEQUENCE;
  }
  return null;
}

export function classifyTerminalKey(
  ev: TerminalKeyEventLike,
  ctx: {
    isLinux: boolean;
    modalOpen: boolean;
    hasSelection: boolean;
  },
): TerminalKeyDecision {
  if (ctx.modalOpen) return { kind: "swallow" };

  const keySequenceOverride = getTerminalKeySequenceOverride(ev);
  if (keySequenceOverride !== null) return { kind: "send", data: keySequenceOverride };

  if (ev.type !== "keydown") return { kind: "passthrough" };

  if (ev.ctrlKey && ev.shiftKey && (ev.key === "c" || ev.key === "C")) {
    return { kind: "action", action: "copySelection" };
  }

  if (ev.ctrlKey && !ev.shiftKey && ev.key === "c" && ctx.hasSelection) {
    return { kind: "action", action: "copySelection" };
  }

  if (ev.ctrlKey && ev.shiftKey && (ev.key === "v" || ev.key === "V")) {
    return { kind: "action", action: "pasteClipboard" };
  }

  if (ev.ctrlKey && !ev.shiftKey && ev.key === "v") {
    return ctx.isLinux
      ? { kind: "passthrough" }
      : { kind: "action", action: "pasteClipboard" };
  }

  if (ev.ctrlKey && ev.key === "Home") return { kind: "action", action: "scrollTop" };
  if (ev.ctrlKey && ev.key === "End") return { kind: "action", action: "scrollBottom" };

  if (ev.altKey && ev.key >= "0" && ev.key <= "9") return { kind: "swallow" };

  if (
    ev.ctrlKey &&
    !ev.shiftKey &&
    !ev.altKey &&
    (ev.key === "t" || ev.key === "w" || ev.key === "k" || ev.key === ",")
  ) {
    return { kind: "swallow" };
  }

  if (ev.ctrlKey && ev.shiftKey && ev.key === "T" && !ev.altKey) {
    return { kind: "swallow" };
  }

  if (ev.ctrlKey && ev.key === "Tab") return { kind: "swallow" };

  if (
    ev.ctrlKey &&
    ev.shiftKey &&
    !ev.altKey &&
    (ev.key === "D" || ev.key === "F" || ev.key === "G" || ev.key === "I" || ev.key === "R")
  ) {
    return { kind: "swallow" };
  }

  if (ev.key === "Escape") return { kind: "swallow" };

  return { kind: "passthrough" };
}
