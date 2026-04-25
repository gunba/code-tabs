/**
 * Structured performance tracing for the debug-build observability pipeline.
 * The in-memory dump remains useful for tests and quick console inspection,
 * while spans also flow into the structured debug log for filtering.
 */
// [DP-15] Unified perf.span frontend tracing: trace/traceAsync/traceSync/manual spans
// feed the same structured observability stream as the rest of the debug log.

import { dlog, type LogLevel } from "./debugLog";

type TraceStatus = "mark" | "start" | "done" | "fail";

interface TraceEntry {
  ts: number;      // ms since page load
  event: string;
  name: string;
  status: TraceStatus;
  durationMs?: number;
  module: string;
  sessionId: string | null;
  data?: unknown;
}

export interface TraceOptions {
  module?: string;
  sessionId?: string | null;
  data?: unknown;
  event?: string;
  warnAboveMs?: number;
  persist?: boolean;
  emitStart?: boolean;
}

export interface TraceSpan {
  end: (extraData?: unknown) => number;
  fail: (error: unknown, extraData?: unknown) => number;
}

const traces: TraceEntry[] = [];
const MAX_TRACES = 5000;
const t0 = performance.now();

function sinceLoadMs(): number {
  return Math.round(performance.now() - t0);
}

function traceLevel(status: TraceStatus, durationMs: number | undefined, warnAboveMs: number | undefined): LogLevel {
  if (status === "fail") return "ERR";
  if (typeof durationMs === "number" && typeof warnAboveMs === "number" && durationMs >= warnAboveMs) {
    return "WARN";
  }
  if (status === "mark") return "LOG";
  return "DEBUG";
}

function messageFor(name: string, status: TraceStatus): string {
  if (status === "mark") return name;
  if (status === "fail") return `${name} [FAIL]`;
  return `${name} [${status}]`;
}

function recordTrace(
  name: string,
  status: TraceStatus,
  options?: TraceOptions,
  durationMs?: number,
  extraData?: unknown,
  error?: unknown,
): TraceEntry {
  const entry: TraceEntry = {
    ts: sinceLoadMs(),
    event: messageFor(name, status),
    name,
    status,
    durationMs,
    module: options?.module ?? "perf",
    sessionId: options?.sessionId ?? null,
    data: options?.data,
  };
  traces.push(entry);
  if (traces.length > MAX_TRACES) {
    traces.splice(0, traces.length - MAX_TRACES);
  }

  const payload: Record<string, unknown> = {
    name,
    status,
    sinceLoadMs: entry.ts,
  };
  if (typeof durationMs === "number") payload.durationMs = durationMs;
  if (options?.data !== undefined) payload.spanData = options.data;
  if (extraData !== undefined) payload.extraData = extraData;
  if (error !== undefined) payload.error = error;

  dlog(
    entry.module,
    entry.sessionId,
    entry.event,
    traceLevel(status, durationMs, options?.warnAboveMs),
    {
      event: options?.event ?? "perf.span",
      persist: options?.persist,
      data: payload,
    },
  );

  return entry;
}

export function trace(event: string, options?: TraceOptions): void {
  recordTrace(event, "mark", options);
}

export function startTraceSpan(event: string, options?: TraceOptions): TraceSpan {
  const start = performance.now();
  const emitStart = options?.emitStart ?? true;
  if (emitStart) {
    recordTrace(event, "start", options);
  }

  let completed = false;

  return {
    end(extraData) {
      if (completed) return Math.round(performance.now() - start);
      completed = true;
      const dur = Math.round(performance.now() - start);
      recordTrace(event, "done", options, dur, extraData);
      return dur;
    },
    fail(error, extraData) {
      if (completed) return Math.round(performance.now() - start);
      completed = true;
      const dur = Math.round(performance.now() - start);
      recordTrace(event, "fail", options, dur, extraData, error);
      return dur;
    },
  };
}

export function traceSync<T>(
  event: string,
  fn: () => T,
  options?: TraceOptions,
): T {
  const span = startTraceSpan(event, { ...options, emitStart: options?.emitStart ?? false });
  try {
    const result = fn();
    span.end();
    return result;
  } catch (err) {
    span.fail(err);
    throw err;
  }
}

export function traceAsync<T>(
  event: string,
  fn: () => Promise<T>,
  options?: TraceOptions,
): Promise<T> {
  const span = startTraceSpan(event, options);
  return fn().then(
    (result) => {
      span.end();
      return result;
    },
    (err) => {
      span.fail(err);
      throw err;
    },
  );
}

export function dumpTraces(): string {
  return traces.map((t) => {
    const dur = typeof t.durationMs === "number" && t.durationMs > 0 ? ` (${t.durationMs}ms)` : "";
    return `+${t.ts}ms  ${t.event}${dur}`;
  }).join("\n");
}

export function getTraces(): readonly TraceEntry[] {
  return traces;
}

export function getTraceStats(): { count: number; maxEntries: number } {
  return { count: traces.length, maxEntries: MAX_TRACES };
}

// Dump on demand via console
(globalThis as Record<string, unknown>).__perfDump = () => {
  const dump = dumpTraces();
  console.log(dump);
  return dump;
};
(globalThis as Record<string, unknown>).__perfEntries = traces;
