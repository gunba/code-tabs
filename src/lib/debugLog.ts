// Structured debug logging — the single entry point for all application logging.
// Zero imports to avoid circular dependencies. Session color lookup happens in the DebugPanel.

export type LogLevel = "DEBUG" | "LOG" | "WARN" | "ERR";

export interface DebugLogEntry {
  ts: number; // Date.now()
  level: LogLevel;
  module: string; // "pty", "inspector", "terminal", etc.
  sessionId: string | null; // null = global/system log
  message: string;
}

const MAX_ENTRIES = 2000;
const buffer: DebugLogEntry[] = [];
(globalThis as Record<string, unknown>).__debugLogEntries = buffer;

/**
 * Structured debug log. Pushes to the structured buffer and forwards to console
 * (which testHarness intercepts for __consoleLogs + test-state.json).
 */
export function dlog(
  module: string,
  sessionId: string | null,
  message: string,
  level: LogLevel = "LOG",
): void {
  buffer.push({ ts: Date.now(), level, module, sessionId, message });
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  const fmt = `[${module}] ${message}`;
  if (level === "WARN") console.warn(fmt);
  else if (level === "ERR") console.error(fmt);
  else console.log(fmt);
}

/** Clear the structured buffer (used by DebugPanel clear action). */
export function clearDebugLog(): void {
  buffer.length = 0;
}

/** Read the structured buffer (used by DebugPanel polling). */
export function getDebugLog(): DebugLogEntry[] {
  return buffer;
}
