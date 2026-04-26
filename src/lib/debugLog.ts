import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LogLevel = "DEBUG" | "LOG" | "WARN" | "ERR";
export type DebugLogSource = "frontend" | "backend";

export interface ObservabilityInfo {
  debugBuild: boolean;
  observabilityEnabled: boolean;
  devtoolsAvailable: boolean;
  globalLogPath: string | null;
}

export interface DebugLogMeta {
  event?: string;
  data?: unknown;
  source?: DebugLogSource;
  persist?: boolean;
}

export interface DebugLogEntry {
  id: number;
  ts: number;
  tsIso: string;
  level: LogLevel;
  module: string;
  source: DebugLogSource;
  sessionId: string | null;
  event: string;
  message: string;
  data: unknown;
}

const GLOBAL_KEY = "__global__";
const MAX_ENTRIES_PER_SESSION = 3000; // [DP-04] Ring buffer capacity per session; 12000 total cap via MAX_TOTAL_ENTRIES
const MAX_TOTAL_ENTRIES = 12000; // [DP-04] Cross-buffer total cap; enforced by trimTotalBuffers()
const MAX_DATA_STRING_LENGTH = 2048;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 30;
const MAX_OBJECT_KEYS = 40;
const FLUSH_INTERVAL_MS = 1500;
const FLUSH_THRESHOLD = 25;
const buffers = new Map<string, DebugLogEntry[]>(); // [DP-13] Per-session ring buffers
const pendingByKey = new Map<string, string[]>();

let generation = 0;
let nextId = 1;
let totalEntryCount = 0;
let debugCaptureEnabled = true;
let debugCaptureResolver: ((sessionId: string | null) => boolean) | null = null;
let observabilityInfo: ObservabilityInfo = {
  debugBuild: false,
  observabilityEnabled: false,
  devtoolsAvailable: false,
  globalLogPath: null,
};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let bridgeStarted = false;
let bridgeUnlisten: (() => void) | null = null;

(globalThis as Record<string, unknown>).__debugLogBuffers = buffers;

function bufferKey(sessionId: string | null): string {
  return sessionId ?? GLOBAL_KEY;
}

function truncateString(value: string, max = MAX_DATA_STRING_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function toSafeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncateString(value.stack || "", 8000),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return {
      byteLength: value.byteLength,
      previewHex: Array.from(value.slice(0, 64)).map((b) => b.toString(16).padStart(2, "0")).join(" "),
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 4) return `[Array(${value.length})]`;
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => toSafeValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    if (depth >= 4) return "[Object]";
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) {
      out[key] = toSafeValue(entry, depth + 1, seen);
    }
    if (entries.length > MAX_OBJECT_KEYS) out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    return out;
  }
  return String(value);
}

function shouldCapture(level: LogLevel): boolean {
  if (!observabilityInfo.observabilityEnabled) return false;
  if (level === "DEBUG" && !debugCaptureResolver && !debugCaptureEnabled) return false;
  return true;
}

function forwardToConsole(entry: DebugLogEntry): void {
  if (!observabilityInfo.debugBuild && entry.level !== "WARN" && entry.level !== "ERR") {
    return;
  }
  const fmt = `[${entry.module}] ${entry.message}`;
  if (entry.level === "WARN") console.warn(fmt);
  else if (entry.level === "ERR") console.error(fmt);
  else console.log(fmt);
}

function startFlushTimer(): void {
  if (flushTimer || !observabilityInfo.observabilityEnabled) return;
  flushTimer = setTimeout(function tick() {
    void flushDebugLog();
    flushTimer = setTimeout(tick, FLUSH_INTERVAL_MS);
  }, FLUSH_INTERVAL_MS);
}

function stopFlushTimer(): void {
  if (!flushTimer) return;
  clearTimeout(flushTimer);
  flushTimer = null;
}

function queuePersist(entry: DebugLogEntry): void {
  if (!observabilityInfo.observabilityEnabled) return;
  const key = bufferKey(entry.sessionId);
  const lines = pendingByKey.get(key) ?? [];
  lines.push(JSON.stringify(entry));
  pendingByKey.set(key, lines);
  if (lines.length >= FLUSH_THRESHOLD) {
    void flushDebugLog();
    return;
  }
  startFlushTimer();
}

function normalizeEntry(entry: Partial<DebugLogEntry> & Pick<DebugLogEntry, "level" | "module" | "message">): DebugLogEntry {
  const ts = typeof entry.ts === "number" ? entry.ts : Date.now();
  return {
    id: typeof entry.id === "number" ? entry.id : nextId++,
    ts,
    tsIso: entry.tsIso || new Date(ts).toISOString(),
    level: entry.level,
    module: entry.module,
    source: entry.source ?? "frontend",
    sessionId: entry.sessionId ?? null,
    event: entry.event || "message",
    message: truncateString(entry.message, MAX_MESSAGE_LENGTH),
    data: toSafeValue(entry.data ?? null),
  };
}

function trimTotalBuffers(): void {
  while (totalEntryCount > MAX_TOTAL_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    let oldestId = Number.POSITIVE_INFINITY;
    for (const [key, buf] of buffers) {
      const first = buf[0];
      if (!first) continue;
      if (first.ts < oldestTs || (first.ts === oldestTs && first.id < oldestId)) {
        oldestKey = key;
        oldestTs = first.ts;
        oldestId = first.id;
      }
    }
    if (!oldestKey) {
      totalEntryCount = 0;
      return;
    }
    const buf = buffers.get(oldestKey);
    if (!buf || buf.length === 0) {
      buffers.delete(oldestKey);
      continue;
    }
    const removeCount = Math.min(buf.length, Math.max(1, totalEntryCount - MAX_TOTAL_ENTRIES));
    buf.splice(0, removeCount);
    totalEntryCount -= removeCount;
    if (buf.length === 0) buffers.delete(oldestKey);
  }
}

function pushEntry(entry: DebugLogEntry, persist: boolean): void {
  if (entry.level === "DEBUG" && debugCaptureResolver && !debugCaptureResolver(entry.sessionId)) {
    return;
  }
  if (!shouldCapture(entry.level)) {
    if (entry.level === "DEBUG") return;
    forwardToConsole(entry);
    return;
  }

  const key = bufferKey(entry.sessionId);
  let buf = buffers.get(key);
  if (!buf) {
    buf = [];
    buffers.set(key, buf);
  }
  buf.push(entry);
  totalEntryCount++;
  if (buf.length > MAX_ENTRIES_PER_SESSION) {
    const removeCount = buf.length - MAX_ENTRIES_PER_SESSION;
    buf.splice(0, removeCount);
    totalEntryCount -= removeCount;
  }
  trimTotalBuffers();
  generation++;

  if (persist) queuePersist(entry);
  forwardToConsole(entry);
}

// [DP-03] All app logging flows through dlog(module, sessionId, message, level?)
export function dlog(
  module: string,
  sessionId: string | null,
  message: string,
  level: LogLevel = "LOG",
  meta?: DebugLogMeta,
): void {
  const entry = normalizeEntry({
    level,
    module,
    sessionId,
    source: meta?.source ?? "frontend",
    event: meta?.event || "message",
    message,
    data: meta?.data,
  });
  pushEntry(entry, meta?.persist !== false);
}

export async function flushDebugLog(): Promise<void> {
  if (!observabilityInfo.observabilityEnabled || pendingByKey.size === 0) return;
  stopFlushTimer();

  const pending = [...pendingByKey.entries()];
  pendingByKey.clear();

  await Promise.all(
    pending.map(async ([key, lines]) => {
      if (lines.length === 0) return;
      try {
        await invoke("append_observability_data", {
          sessionId: key === GLOBAL_KEY ? null : key,
          lines: `${lines.join("\n")}\n`,
        });
      } catch {
        // Best effort; keep runtime logging alive even if disk append fails.
      }
    }),
  );
}

export function configureObservability(info: ObservabilityInfo): void {
  observabilityInfo = info;
  if (!info.observabilityEnabled) {
    pendingByKey.clear();
    stopFlushTimer();
  }
}

export function getObservabilityInfo(): ObservabilityInfo {
  return observabilityInfo;
}

export async function startObservabilityBridge(): Promise<void> {
  if (bridgeStarted || !observabilityInfo.observabilityEnabled) return;
  bridgeStarted = true;
  const unlisten = await listen<DebugLogEntry>("observability-entry", (event) => {
    const entry = normalizeEntry({
      ...event.payload,
      level: event.payload.level,
      module: event.payload.module,
      message: event.payload.message,
    });
    pushEntry(entry, false);
  });
  bridgeUnlisten = () => {
    unlisten();
    bridgeStarted = false;
    bridgeUnlisten = null;
  };
}

export function stopObservabilityBridge(): void {
  bridgeUnlisten?.();
}

export function clearDebugLog(): void {
  buffers.clear();
  pendingByKey.clear();
  totalEntryCount = 0;
  stopFlushTimer();
  generation++;
}

export function getDebugLog(limit?: number): DebugLogEntry[] {
  const all: DebugLogEntry[] = [];
  for (const buf of buffers.values()) {
    for (let i = 0; i < buf.length; i++) all.push(buf[i]);
  }
  all.sort((a, b) => a.ts - b.ts || a.id - b.id);
  if (typeof limit === "number" && limit > 0 && all.length > limit) {
    return all.slice(all.length - limit);
  }
  return all;
}

export function getDebugLogForSession(sessionId: string | null): readonly DebugLogEntry[] {
  return buffers.get(bufferKey(sessionId)) ?? [];
}

export function removeDebugLogSession(sessionId: string): void {
  const key = bufferKey(sessionId);
  totalEntryCount -= buffers.get(key)?.length ?? 0;
  buffers.delete(key);
  pendingByKey.delete(bufferKey(sessionId));
  generation++;
}

export function getDebugLogGeneration(): number {
  return generation;
}

export function setDebugCaptureEnabled(enabled: boolean): void {
  debugCaptureEnabled = enabled;
}

export function setDebugCaptureResolver(resolver: ((sessionId: string | null) => boolean) | null): void {
  debugCaptureResolver = resolver;
}

export interface DebugLogStats {
  totalEntries: number;
  totalPendingLines: number;
  bufferCount: number;
  maxEntriesPerSession: number;
  maxTotalEntries: number;
  entriesByBuffer: Array<{ key: string; entries: number; pendingLines: number }>;
}

export function getDebugLogStats(): DebugLogStats {
  return {
    totalEntries: totalEntryCount,
    totalPendingLines: [...pendingByKey.values()].reduce((sum, lines) => sum + lines.length, 0),
    bufferCount: buffers.size,
    maxEntriesPerSession: MAX_ENTRIES_PER_SESSION,
    maxTotalEntries: MAX_TOTAL_ENTRIES,
    entriesByBuffer: [...buffers.entries()].map(([key, entries]) => ({
      key,
      entries: entries.length,
      pendingLines: pendingByKey.get(key)?.length ?? 0,
    })),
  };
}
