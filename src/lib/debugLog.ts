// [DP-03] Structured debug logging — single entry point for all app logging via dlog()
// Zero imports to avoid circular dependencies. Session color lookup happens in the DebugPanel.

export type LogLevel = "DEBUG" | "LOG" | "WARN" | "ERR";

export interface DebugLogEntry {
  ts: number; // Date.now()
  level: LogLevel;
  module: string; // "pty", "inspector", "terminal", etc.
  sessionId: string | null; // null = global/system log
  message: string;
}

const GLOBAL_KEY = "__global__";
const MAX_ENTRIES = 5000; // [DP-04] Ring buffer: 5000 entries PER SESSION, oldest evicted first
// [DP-13] Per-session buffers: each sessionId (and null/global) maps to its own ring buffer
const buffers = new Map<string, DebugLogEntry[]>();
let generation = 0; // Increments on every push; lets poll detect changes when buffer is full
let debugCaptureEnabled = true; // [CI-06] Toggled via setDebugCaptureEnabled; controls DEBUG-level capture
(globalThis as Record<string, unknown>).__debugLogBuffers = buffers;

function bufferKey(sessionId: string | null): string {
  return sessionId ?? GLOBAL_KEY;
}

/** Structured debug log. Pushes to the per-session buffer and forwards to console. */
export function dlog(
  module: string,
  sessionId: string | null,
  message: string,
  level: LogLevel = "LOG",
): void {
  if (level === "DEBUG" && !debugCaptureEnabled) return;

  const key = bufferKey(sessionId);
  let buf = buffers.get(key);
  if (!buf) {
    buf = [];
    buffers.set(key, buf);
  }
  buf.push({ ts: Date.now(), level, module, sessionId, message });
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  generation++;

  const fmt = `[${module}] ${message}`;
  if (level === "WARN") console.warn(fmt);
  else if (level === "ERR") console.error(fmt);
  else console.log(fmt);
}

/** Clear all per-session buffers (used by DebugPanel clear action). */
export function clearDebugLog(): void {
  buffers.clear();
  generation++;
}

/** Read all entries merged across sessions, sorted by timestamp (used by DebugPanel "all" view). */
export function getDebugLog(): DebugLogEntry[] {
  const all: DebugLogEntry[] = [];
  for (const buf of buffers.values()) {
    for (let i = 0; i < buf.length; i++) all.push(buf[i]);
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
}

/** Read entries for a single session (null = global). Returns the buffer directly — do not mutate. */
export function getDebugLogForSession(sessionId: string | null): readonly DebugLogEntry[] {
  return buffers.get(bufferKey(sessionId)) ?? [];
}

/** Remove a session's buffer (called on session close). [DP-14] */
export function removeDebugLogSession(sessionId: string): void {
  buffers.delete(sessionId);
  generation++;
}

/** Current generation (increments on every push/clear/remove). */
export function getDebugLogGeneration(): number {
  return generation;
}

/** Set whether DEBUG-level entries are captured. Called from settings store sync. */
export function setDebugCaptureEnabled(enabled: boolean): void {
  debugCaptureEnabled = enabled;
}
