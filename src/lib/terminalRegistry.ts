/**
 * Global registry mapping session IDs to terminal buffer extraction functions.
 * Used by command palette "Copy Transcript" and export features.
 */

const bufferReaders = new Map<string, () => string>();
const tailReaders = new Map<string, (lines: number) => string>();

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
