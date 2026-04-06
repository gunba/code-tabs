// [TR-16] Terminal buffer reader, SearchAddon, and scrollToLine registry

import type { Terminal } from "@xterm/xterm";
import { dlog } from "./debugLog";

const bufferReaders = new Map<string, () => string>();
const terminals = new Map<string, Terminal>();
const terminalResizeNudgers = new Map<string, (reason: string) => boolean>();
const scrollFns = new Map<string, (line: number) => void>();

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

export function registerTerminal(sessionId: string, term: Terminal): void {
  terminals.set(sessionId, term);
}

export function registerTerminalResizeNudger(sessionId: string, nudge: (reason: string) => boolean): void {
  terminalResizeNudgers.set(sessionId, nudge);
}

export function unregisterTerminalResizeNudger(sessionId: string): void {
  terminalResizeNudgers.delete(sessionId);
}

export function unregisterTerminal(sessionId: string): void {
  terminals.delete(sessionId);
}

export function nudgeTerminalResize(sessionId: string): boolean {
  const nudge = terminalResizeNudgers.get(sessionId);
  if (!nudge) {
    dlog("terminal", sessionId, "debug resize nudge requested without registered terminal", "WARN", {
      event: "terminal.debug_resize_nudge_missing",
      data: {
        sessionId,
        hasTerminal: terminals.has(sessionId),
      },
    });
    return false;
  }

  dlog("terminal", sessionId, "debug resize nudge requested", "LOG", {
    event: "terminal.debug_resize_nudge",
    data: {
      sessionId,
      hasTerminal: terminals.has(sessionId),
    },
  });
  const dispatched = nudge("debug_resize_nudge");
  dlog("terminal", sessionId, dispatched ? "debug resize nudge dispatched" : "debug resize nudge skipped", dispatched ? "LOG" : "WARN", {
    event: dispatched ? "terminal.debug_resize_nudge_dispatched" : "terminal.debug_resize_nudge_skipped",
    data: {
      sessionId,
      hasTerminal: terminals.has(sessionId),
    },
  });
  return dispatched;
}

/** Highlight a match in a session's terminal via selection API. */
export function highlightMatch(sessionId: string, lineIndex: number, col: number, length: number): void {
  const term = terminals.get(sessionId);
  if (term) term.select(col, lineIndex, length);
}

/** Clear highlight (selection) in a session's terminal. */
export function clearHighlight(sessionId: string): void {
  const term = terminals.get(sessionId);
  if (term) term.clearSelection();
}

export function registerScrollToLine(sessionId: string, fn: (line: number) => void): void {
  scrollFns.set(sessionId, fn);
}

export function unregisterScrollToLine(sessionId: string): void {
  scrollFns.delete(sessionId);
}

export function scrollSessionToLine(sessionId: string, line: number): void {
  const fn = scrollFns.get(sessionId);
  if (fn) fn(line);
}
