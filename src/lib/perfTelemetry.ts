import { listen } from "@tauri-apps/api/event";
import { dlog, getDebugLogStats } from "./debugLog";
import { getTraceStats } from "./perfTrace";
import { getRegisteredTerminalStats } from "./terminalRegistry";

const DEFAULT_SAMPLE_INTERVAL_MS = 5000;
const LONG_TASK_WARN_MS = 200;
const EVENT_WARN_MS = 120;
const RESOURCE_WARN_MS = 1000;
const RESOURCE_SIZE_WARN_BYTES = 1_000_000;

type AppProcessMetrics = {
  pid: number;
  cpu: number;
  mem: number;
  childrenCpu?: number;
  childrenMem?: number;
  childCount?: number;
};

type MemoryPerformance = Performance & {
  memory?: {
    jsHeapSizeLimit: number;
    totalJSHeapSize: number;
    usedJSHeapSize: number;
  };
};

let started = false;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let observers: PerformanceObserver[] = [];
let appMetrics: AppProcessMetrics | null = null;
let appMetricsUnlisten: Promise<() => void> | null = null;

function supportedEntryTypes(): ReadonlySet<string> {
  const ctor = globalThis.PerformanceObserver;
  const types = ctor?.supportedEntryTypes ?? [];
  return new Set(types);
}

function observe(type: string, handler: (entry: PerformanceEntry) => void, options?: PerformanceObserverInit): void {
  if (typeof PerformanceObserver === "undefined") return;
  if (!supportedEntryTypes().has(type)) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) handler(entry);
    });
    observer.observe(options ?? { type, buffered: true });
    observers.push(observer);
  } catch {
    // Browser/WebView support differs by platform; unsupported entry types are optional.
  }
}

function memorySnapshot() {
  const mem = (performance as MemoryPerformance).memory;
  if (!mem) return null;
  return {
    jsHeapSizeLimit: mem.jsHeapSizeLimit,
    totalJSHeapSize: mem.totalJSHeapSize,
    usedJSHeapSize: mem.usedJSHeapSize,
  };
}

function sample(): void {
  dlog("perf", null, "frontend performance sample", "DEBUG", {
    event: "perf.sample",
    data: {
      memory: memorySnapshot(),
      appProcess: appMetrics,
      dom: {
        nodes: document.getElementsByTagName("*").length,
        scripts: document.scripts.length,
        stylesheets: document.styleSheets.length,
      },
      debugLog: getDebugLogStats(),
      traces: getTraceStats(),
      terminals: getRegisteredTerminalStats(),
    },
  });
}

function entryBase(entry: PerformanceEntry): Record<string, unknown> {
  return {
    name: entry.name,
    entryType: entry.entryType,
    startTime: Math.round(entry.startTime),
    durationMs: Math.round(entry.duration),
  };
}

export function startFrontendPerfTelemetry(sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS): void {
  if (started) return;
  started = true;

  appMetricsUnlisten = listen<AppProcessMetrics>("app-process-metrics", (event) => {
    appMetrics = event.payload;
  });

  observe("longtask", (entry) => {
    const duration = Math.round(entry.duration);
    dlog("perf", null, `long task ${duration}ms`, duration >= LONG_TASK_WARN_MS ? "WARN" : "DEBUG", {
      event: "perf.longtask",
      data: entryBase(entry),
    });
  });

  observe("event", (entry) => {
    const duration = Math.round(entry.duration);
    if (duration < EVENT_WARN_MS) return;
    dlog("perf", null, `slow UI event ${duration}ms`, "WARN", {
      event: "perf.slow_event",
      data: entryBase(entry),
    });
  }, { type: "event", buffered: true, durationThreshold: EVENT_WARN_MS } as PerformanceObserverInit);

  observe("resource", (entry) => {
    const resource = entry as PerformanceResourceTiming;
    const duration = Math.round(resource.duration);
    const size = resource.transferSize || resource.decodedBodySize || resource.encodedBodySize || 0;
    if (duration < RESOURCE_WARN_MS && size < RESOURCE_SIZE_WARN_BYTES) return;
    dlog("perf", null, `resource ${duration}ms ${size}B`, duration >= RESOURCE_WARN_MS ? "WARN" : "DEBUG", {
      event: "perf.resource",
      data: {
        ...entryBase(resource),
        initiatorType: resource.initiatorType,
        transferSize: resource.transferSize,
        decodedBodySize: resource.decodedBodySize,
        encodedBodySize: resource.encodedBodySize,
      },
    });
  });

  observe("measure", (entry) => {
    dlog("perf", null, `measure ${entry.name}`, "DEBUG", {
      event: "perf.measure",
      data: entryBase(entry),
    });
  });

  sample();
  sampleTimer = setInterval(sample, sampleIntervalMs);
}

export function stopFrontendPerfTelemetry(): void {
  if (!started) return;
  started = false;
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  observers.forEach((observer) => observer.disconnect());
  observers = [];
  appMetricsUnlisten?.then((unlisten) => unlisten()).catch(() => {});
  appMetricsUnlisten = null;
  appMetrics = null;
}
