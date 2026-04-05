// [TR-16] Terminal buffer reader, SearchAddon, and scrollToLine registry

import type { Terminal } from "@xterm/xterm";

const bufferReaders = new Map<string, () => string>();
const terminals = new Map<string, Terminal>();
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

export function unregisterTerminal(sessionId: string): void {
  terminals.delete(sessionId);
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
