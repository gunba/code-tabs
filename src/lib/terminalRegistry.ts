/**
 * Global registry mapping session IDs to terminal buffer extraction functions,
 * search addons, and scroll callbacks.
 */

import type { SearchAddon } from "@xterm/addon-search";

const bufferReaders = new Map<string, () => string>();
const tailReaders = new Map<string, (lines: number) => string>();
const searchAddons = new Map<string, SearchAddon>();
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

export function registerTailReader(sessionId: string, reader: (lines: number) => string): void {
  tailReaders.set(sessionId, reader);
}

export function unregisterTailReader(sessionId: string): void {
  tailReaders.delete(sessionId);
}

export function getSessionBufferTail(sessionId: string, lines: number): string | null {
  const reader = tailReaders.get(sessionId);
  return reader ? reader(lines) : null;
}

export function registerSearchAddon(sessionId: string, addon: SearchAddon): void {
  searchAddons.set(sessionId, addon);
}

export function unregisterSearchAddon(sessionId: string): void {
  searchAddons.delete(sessionId);
}

export function getSearchAddon(sessionId: string): SearchAddon | null {
  return searchAddons.get(sessionId) ?? null;
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
