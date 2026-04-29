// [TR-16] Terminal buffer reader and render-wait registry

import type { Terminal } from "@xterm/xterm";

const bufferReaders = new Map<string, () => string>();
const terminals = new Map<string, Terminal>();

export function registerBufferReader(sessionId: string, getBufferText: () => string): void {
  bufferReaders.set(sessionId, getBufferText);
}

export function unregisterBufferReader(sessionId: string): void {
  bufferReaders.delete(sessionId);
}

export function getSessionTranscript(sessionId: string): string | null {
  const reader = bufferReaders.get(sessionId);
  return reader ? reader() : null;
}

export function getSessionViewport(sessionId: string): string | null {
  const term = terminals.get(sessionId);
  if (!term) return null;
  const buf = term.buffer.active;
  const lines: string[] = [];
  const start = buf.viewportY;
  const end = Math.min(buf.length, start + term.rows);
  for (let i = start; i < end; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

export function registerTerminal(sessionId: string, term: Terminal): void {
  terminals.set(sessionId, term);
}

export function focusTerminal(sessionId: string): void {
  terminals.get(sessionId)?.focus();
}

export function unregisterTerminal(sessionId: string): void {
  terminals.delete(sessionId);
}

export function getRegisteredTerminalStats(): Array<{
  sessionId: string;
  cols: number;
  rows: number;
  bufferLength: number;
  baseY: number;
  viewportY: number;
  altScreen: boolean;
}> {
  return [...terminals.entries()].map(([sessionId, term]) => {
    const buf = term.buffer.active;
    return {
      sessionId,
      cols: term.cols,
      rows: term.rows,
      bufferLength: buf.length,
      baseY: buf.baseY,
      viewportY: buf.viewportY,
      altScreen: buf.type === "alternate",
    };
  });
}

/**
 * Resolve on the next deterministic xterm.js activity signal.
 *
 * No timeout fallback: callers must pass an AbortSignal when the wait is tied
 * to a cancellable workflow.
 */
export function waitForRender(sessionId: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const term = terminals.get(sessionId);
    if (!term || signal?.aborted) { resolve(false); return; }

    let done = false;
    const disposables: Array<{ dispose(): void }> = [];
    const finish = (activity: boolean) => {
      if (done) return;
      done = true;
      for (const disposable of disposables) disposable.dispose();
      signal?.removeEventListener("abort", abort);
      resolve(activity);
    };
    const abort = () => finish(false);

    signal?.addEventListener("abort", abort, { once: true });
    disposables.push(term.onRender(() => finish(true)));

    const maybeTerm = term as Terminal & {
      onWriteParsed?: (listener: () => void) => { dispose(): void };
      onScroll?: (listener: (position: number) => void) => { dispose(): void };
    };
    if (maybeTerm.onWriteParsed) {
      disposables.push(maybeTerm.onWriteParsed(() => finish(true)));
    }
    if (maybeTerm.onScroll) {
      disposables.push(maybeTerm.onScroll(() => finish(true)));
    }
  });
}

/** Check whether the terminal's active buffer is the alternate screen. */
export function isAltScreen(sessionId: string): boolean {
  const term = terminals.get(sessionId);
  if (!term) return false;
  return term.buffer.active.type === "alternate";
}

/**
 * Search the terminal's scrollback buffer for text and scroll to the first
 * matching line. Best-effort fallback for normal-screen mode where PTY-based
 * scrolling (Page Up) doesn't work.
 *
 * Scans bottom-to-top (recent matches more relevant). Case-insensitive,
 * whitespace-normalized. Two-pass: single lines, then adjacent pairs for
 * line-wrapped matches. Offsets scroll by rows/3 so the match appears
 * roughly one-third from the top.
 */
export function scrollBufferToText(sessionId: string, targetText: string | string[]): boolean {
  const term = terminals.get(sessionId);
  if (!term) return false;

  const buf = term.buffer.active;
  const normalizedTargets = (Array.isArray(targetText) ? targetText : [targetText])
    .map((target) => target.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  if (!normalizedTargets.length) return false;

  const includesTarget = (text: string) => normalizedTargets.some((target) => text.includes(target));

  const offset = Math.floor(term.rows / 3);

  // Pass 1: single lines, bottom-to-top
  for (let i = buf.length - 1; i >= 0; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).replace(/\s+/g, " ").trim().toLowerCase();
    if (includesTarget(text)) {
      term.scrollToLine(Math.max(0, i - offset));
      return true;
    }
  }

  // Pass 2: adjacent line pairs (target may span a line break)
  for (let i = buf.length - 2; i >= 0; i--) {
    const line1 = buf.getLine(i);
    const line2 = buf.getLine(i + 1);
    if (!line1 || !line2) continue;
    const combined = (
      line1.translateToString(true) + " " + line2.translateToString(true)
    ).replace(/\s+/g, " ").trim().toLowerCase();
    if (includesTarget(combined)) {
      term.scrollToLine(Math.max(0, i - offset));
      return true;
    }
  }

  return false;
}
