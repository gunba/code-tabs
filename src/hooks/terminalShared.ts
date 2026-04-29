import type { Terminal } from "@xterm/xterm";

export const TERMINAL_FONT_FAMILY = "'Pragmasevka', 'Roboto Mono', 'ClaudeEmoji', monospace";

// [DF-05] xterm.js 6.0 with DEC 2026 synchronized output - coalesces ink BSU/ESU diff frames so rapid TUI writes don't flash partial buffers.
export const XTVERSION_REPLY = "\x1bP>|xterm.js(6.0.0)\x1b\\";

export const terminalOutputDecoder = new TextDecoder();

export function escapePreview(text: string): string {
  return text
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .slice(0, 240);
}

export function captureBufferState(term: Terminal) {
  const buf = term.buffer.active;
  return {
    cols: term.cols,
    rows: term.rows,
    cursorX: buf.cursorX,
    cursorY: buf.baseY + buf.cursorY,
    viewportY: buf.viewportY,
    baseY: buf.baseY,
    length: buf.length,
  };
}

export function isElementVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
