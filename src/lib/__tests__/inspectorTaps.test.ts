/* eslint-disable @typescript-eslint/no-explicit-any */
declare const process: any;
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { INSTALL_TAPS, tapToggleExpr, tapToggleAllExpr } from "../inspectorHooks";

// Snapshot ALL patchable globals once at module load, before any INSTALL_TAPS.
const _pristine = {
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  stdoutWrite: process.stdout.write,
  stderrWrite: process.stderr.write,
  consoleLog: console.log,
  consoleWarn: console.warn,
  consoleError: console.error,
  consoleDebug: console.debug,
  processExit: process.exit,
  Bun: (globalThis as any).Bun,
};

function restoreGlobals() {
  JSON.parse = _pristine.jsonParse;
  JSON.stringify = _pristine.jsonStringify;
  globalThis.setTimeout = _pristine.setTimeout;
  globalThis.clearTimeout = _pristine.clearTimeout;
  globalThis.setInterval = _pristine.setInterval;
  globalThis.clearInterval = _pristine.clearInterval;
  process.stdout.write = _pristine.stdoutWrite;
  process.stderr.write = _pristine.stderrWrite;
  console.log = _pristine.consoleLog;
  console.warn = _pristine.consoleWarn;
  console.error = _pristine.consoleError;
  console.debug = _pristine.consoleDebug;
  process.exit = _pristine.processExit;
  if (_pristine.Bun) {
    (globalThis as any).Bun = _pristine.Bun;
  } else {
    delete (globalThis as any).Bun;
  }
}

function cleanupTapHooks() {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__tapsInstalled;
  delete g.__tapFlags;
  delete g.__tapFetchInstalled;
  delete g.__tapFetchTimeoutInstalled;
  delete g.__tapDiag;
  delete process.env.TAP_PORT;
  restoreGlobals();
}

/** Mute always-on parse/stringify flags to prevent vitest's internal JSON ops from flooding captures. */
function muteTapDefaults() {
  const g = globalThis as unknown as Record<string, unknown>;
  const flags = g.__tapFlags as Record<string, boolean> | undefined;
  if (flags) { flags.parse = false; flags.stringify = false; }
}

/** Pre-compiled INSTALL_TAPS function. */
const _installTapsFn = new Function(`return ${INSTALL_TAPS}`);

let mockTapWrites: string[] = [];

/**
 * INSTALL_TAPS push() connects to TAP_PORT via Bun.connect (native TCP).
 * In vitest, we mock globalThis.Bun with a fake connect that captures socket writes.
 * The open handler is deferred via queueMicrotask to match real async behavior.
 */
function setupMockTcpTransport() {
  mockTapWrites = [];
  process.env.TAP_PORT = "9999";

  const mockSocket = {
    write: (data: string) => { mockTapWrites.push(data); return data.length; },
  };

  (globalThis as any).Bun = {
    connect: (opts: any) => {
      // Defer the open callback — Bun.connect resolves async in real runtime
      queueMicrotask(() => opts.socket.open(mockSocket));
      return Promise.resolve(mockSocket);
    },
  };
}

/** Install taps, then await mock TCP connect (open handler fires via microtask). */
async function installTaps() {
  const result = _installTapsFn();
  await new Promise<void>((r) => queueMicrotask(r));
  return result;
}

/** Collect TAP entries from mock TCP socket writes.
 *  Uses _pristine.jsonParse to avoid triggering the wrapped JSON.parse. */
function collectTapEntries(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of mockTapWrites) {
    const trimmed = line.trim();
    if (trimmed) {
      try { entries.push(_pristine.jsonParse(trimmed)); } catch {}
    }
  }
  return entries;
}

describe("INSTALL_TAPS", () => {
  beforeEach(() => { cleanupTapHooks(); setupMockTcpTransport(); });
  afterEach(cleanupTapHooks);

  it("returns 'ok' on first install", async () => {
    expect(await installTaps()).toBe("ok");
  });

  it("returns 'already' on second install", async () => {
    await installTaps();
    expect(await installTaps()).toBe("already");
  });

  it("initializes __tapFlags with parse+stringify always-on", async () => {
    await installTaps();
    const g = globalThis as unknown as Record<string, unknown>;
    const flags = g.__tapFlags as Record<string, boolean>;
    expect(flags.parse).toBe(true);
    expect(flags.stringify).toBe(true);
    expect(flags.console).toBe(false);
    expect(flags.fs).toBe(false);
    expect(flags.spawn).toBe(false);
    expect(flags.fetch).toBe(false);
    expect(flags.exit).toBe(false);
    expect(flags.timer).toBe(false);
    expect(flags.stdout).toBe(false);
    expect(flags.require).toBe(false);
  });
});

describe("INSTALL_TAPS JSON.parse hook", () => {
  beforeEach(async () => {
    cleanupTapHooks();
    setupMockTcpTransport();
    await installTaps();
    muteTapDefaults();
  });
  afterEach(cleanupTapHooks);

  it("pushes parse entries via TCP socket (parse is always-on)", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).parse = true;
    mockTapWrites = [];
    const big = JSON.stringify({ type: "message", content: "x".repeat(100) });
    JSON.parse(big);
    const entries = collectTapEntries();
    const parseEntries = entries.filter((e) => e.cat === "parse");
    expect(parseEntries.length).toBeGreaterThanOrEqual(1);
    const entry = parseEntries[parseEntries.length - 1];
    expect(entry.cat).toBe("parse");
    expect(typeof entry.ts).toBe("number");
    expect(typeof entry.len).toBe("number");
    expect(typeof entry.snap).toBe("string");
  });

  it("is no-op when parse flag is disabled", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).parse = false;
    mockTapWrites = [];
    const big = JSON.stringify({ type: "message", content: "x".repeat(100) });
    JSON.parse(big);
    const entries = collectTapEntries().filter((e) => e.cat === "parse");
    expect(entries.length).toBe(0);
  });

  it("captures short strings (no length filter)", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).parse = true;
    mockTapWrites = [];
    JSON.parse('{"a":1}');
    const entries = collectTapEntries().filter((e) => e.cat === "parse");
    expect(entries.length).toBe(1);
  });

  it("captures primitives (no type filter)", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).parse = true;
    mockTapWrites = [];
    JSON.parse('"hello"');
    const entries = collectTapEntries().filter((e) => e.cat === "parse");
    expect(entries.length).toBe(1);
  });
});

describe("INSTALL_TAPS console hooks", () => {
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeEach(async () => {
    cleanupTapHooks();
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    setupMockTcpTransport();
    await installTaps();
    muteTapDefaults();
  });
  afterEach(() => {
    cleanupTapHooks();
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  it("captures console.warn when flag is true", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).console = true;
    mockTapWrites = [];
    console.warn("test warning");
    const entries = collectTapEntries().filter((e) => e.cat === "console.warn");
    expect(entries.length).toBe(1);
    expect(entries[0].msg).toBe("test warning");
  });

  it("is no-op when console flag is false", () => {
    mockTapWrites = [];
    console.log("invisible");
    const entries = collectTapEntries().filter((e) => String(e.cat).startsWith("console."));
    expect(entries.length).toBe(0);
  });
});

describe("tapToggleExpr / tapToggleAllExpr", () => {
  beforeEach(async () => { cleanupTapHooks(); setupMockTcpTransport(); await installTaps(); muteTapDefaults(); });
  afterEach(cleanupTapHooks);

  it("toggles a single category", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    new Function(`return ${tapToggleExpr("parse", true)}`)();
    expect((g.__tapFlags as Record<string, boolean>).parse).toBe(true);
    expect((g.__tapFlags as Record<string, boolean>).console).toBe(false);
    new Function(`return ${tapToggleExpr("parse", false)}`)();
    expect((g.__tapFlags as Record<string, boolean>).parse).toBe(false);
  });

  it("toggles all optional categories (parse+stringify stay always-on)", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const flags = g.__tapFlags as Record<string, boolean>;
    // Restore parse+stringify to their default always-on state before testing toggleAll
    flags.parse = true;
    flags.stringify = true;
    new Function(`return ${tapToggleAllExpr(true)}`)();
    // parse and stringify unchanged by toggleAll (always-on)
    expect(flags.parse).toBe(true);
    expect(flags.stringify).toBe(true);
    expect(flags.console).toBe(true);
    expect(flags.fs).toBe(true);
    expect(flags.spawn).toBe(true);
    expect(flags.fetch).toBe(true);
    expect(flags.exit).toBe(true);
    expect(flags.timer).toBe(true);
    expect(flags.stdout).toBe(true);
    expect(flags.stderr).toBe(true);
    expect(flags.require).toBe(true);
    expect(flags.bun).toBe(true);
    new Function(`return ${tapToggleAllExpr(false)}`)();
    expect(flags.parse).toBe(true);
    expect(flags.stringify).toBe(true);
    expect(flags.console).toBe(false);
    expect(flags.fs).toBe(false);
    expect(flags.spawn).toBe(false);
    expect(flags.fetch).toBe(false);
    expect(flags.exit).toBe(false);
    expect(flags.timer).toBe(false);
    expect(flags.stdout).toBe(false);
    expect(flags.stderr).toBe(false);
    expect(flags.require).toBe(false);
    expect(flags.bun).toBe(false);
  });

  it("toggles new categories individually", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const flags = g.__tapFlags as Record<string, boolean>;
    new Function(`return ${tapToggleExpr("spawn", true)}`)();
    expect(flags.spawn).toBe(true);
    expect(flags.fetch).toBe(false);
    new Function(`return ${tapToggleExpr("fetch", true)}`)();
    expect(flags.fetch).toBe(true);
    new Function(`return ${tapToggleExpr("timer", true)}`)();
    expect(flags.timer).toBe(true);
    new Function(`return ${tapToggleExpr("stdout", true)}`)();
    expect(flags.stdout).toBe(true);
  });

  it("tapToggleExpr is safe when __tapFlags is absent", () => {
    cleanupTapHooks();
    const result = new Function(`return ${tapToggleExpr("parse", true)}`)();
    expect(result).toBe("ok");
  });
});

describe("INSTALL_TAPS console hooks — all methods", () => {
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeEach(async () => {
    cleanupTapHooks();
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    setupMockTcpTransport();
    await installTaps();
    muteTapDefaults();
  });
  afterEach(() => {
    cleanupTapHooks();
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  it("captures console.log", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).console = true;
    mockTapWrites = [];
    console.log("test log");
    const entries = collectTapEntries();
    expect(entries.some((e) => e.cat === "console.log" && e.msg === "test log")).toBe(true);
  });

  it("captures console.error", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).console = true;
    mockTapWrites = [];
    console.error("test error");
    const entries = collectTapEntries();
    expect(entries.some((e) => e.cat === "console.error" && e.msg === "test error")).toBe(true);
  });

  it("joins multiple arguments with space", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).console = true;
    mockTapWrites = [];
    console.log("a", "b", "c");
    const entries = collectTapEntries();
    expect(entries.some((e) => e.msg === "a b c")).toBe(true);
  });
});

describe("INSTALL_TAPS stdout hook", () => {
  const proc = () => (globalThis as unknown as { process: { stdout: { write: (s: string) => boolean } } }).process;
  let origWrite: (s: string) => boolean;

  beforeEach(async () => {
    cleanupTapHooks();
    origWrite = proc().stdout.write;
    setupMockTcpTransport();
    await installTaps();
    muteTapDefaults();
  });
  afterEach(() => {
    cleanupTapHooks();
    proc().stdout.write = origWrite;
  });

  it("captures stdout.write with length and snap", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).stdout = true;
    mockTapWrites = [];
    proc().stdout.write("test output");
    const entries = collectTapEntries().filter((e) => e.cat === "stdout");
    expect(entries.length).toBe(1);
    expect(entries[0].len).toBe(11);
    expect(entries[0].snap).toBe("test output");
  });

  it("is no-op when stdout flag is false", () => {
    mockTapWrites = [];
    proc().stdout.write("invisible");
    const entries = collectTapEntries().filter((e) => e.cat === "stdout");
    expect(entries.length).toBe(0);
  });
});

describe("INSTALL_TAPS timer hook", () => {
  beforeEach(async () => {
    cleanupTapHooks();
    setupMockTcpTransport();
    await installTaps();
    muteTapDefaults();
  });
  afterEach(cleanupTapHooks);

  it("captures setTimeout with delay >= 100", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).timer = true;
    mockTapWrites = [];
    const id = setTimeout(() => {}, 200);
    clearTimeout(id);
    const entries = collectTapEntries().filter((e) => e.cat === "setTimeout");
    expect(entries.length).toBe(1);
    expect(entries[0].delay).toBe(200);
    expect(typeof entries[0].caller).toBe("string");
  });

  it("skips setTimeout with delay < 100", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).timer = true;
    mockTapWrites = [];
    const id = setTimeout(() => {}, 10);
    clearTimeout(id);
    const entries = collectTapEntries().filter((e) => e.cat === "setTimeout");
    expect(entries.length).toBe(0);
  });
});

describe("INSTALL_TAPS status-line capture", () => {
  beforeEach(async () => {
    cleanupTapHooks();
    setupMockTcpTransport();
    await installTaps();
    muteTapDefaults();
  });
  afterEach(cleanupTapHooks);

  it("captures status-line payload via dedicated category", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).stringify = true;
    mockTapWrites = [];
    JSON.stringify({
      hook_event_name: "Status",
      session_id: "abc123",
      cwd: "/test",
      model: { id: "claude-opus-4-6[1m]", display_name: "Opus 4.6" },
      version: "2.1.80",
      cost: { total_cost_usd: 0.05, total_duration_ms: 30000, total_api_duration_ms: 1500, total_lines_added: 50, total_lines_removed: 5 },
      context_window: { total_input_tokens: 10000, total_output_tokens: 2000, context_window_size: 1000000, current_usage: { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 }, used_percentage: 2, remaining_percentage: 98 },
      rate_limits: { five_hour: { used_percentage: 30, resets_at: 12345 }, seven_day: { used_percentage: 10, resets_at: 67890 } },
      vim: { mode: "NORMAL" },
      output_style: { name: "default" },
    });
    await new Promise<void>((r) => queueMicrotask(r));
    const entries = collectTapEntries();
    const statusEntries = entries.filter((e) => e.cat === "status-line");
    expect(statusEntries.length).toBe(1);
    expect(statusEntries[0].sessionId).toBe("abc123");
    expect(statusEntries[0].cliVersion).toBe("2.1.80");
    expect(statusEntries[0].fiveHourUsedPercent).toBe(30);
    expect(statusEntries[0].sevenDayResetsAt).toBe(67890);
    expect(statusEntries[0].modelId).toBe("claude-opus-4-6[1m]");
    expect(statusEntries[0].modelDisplayName).toBe("Opus 4.6");
    expect(statusEntries[0].outputStyle).toBe("default");
    // Also verify the generic stringify entry fires (dual push)
    const stringifyEntries = entries.filter((e) => e.cat === "stringify");
    expect(stringifyEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("handles string model (not object) in status payload", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    (g.__tapFlags as Record<string, boolean>).stringify = true;
    mockTapWrites = [];
    JSON.stringify({
      hook_event_name: "Status",
      session_id: "def456",
      model: "claude-sonnet-4-6",
    });
    await new Promise<void>((r) => queueMicrotask(r));
    const entries = collectTapEntries();
    const statusEntries = entries.filter((e) => e.cat === "status-line");
    expect(statusEntries.length).toBe(1);
    expect(statusEntries[0].modelId).toBe("claude-sonnet-4-6");
    expect(statusEntries[0].modelDisplayName).toBe("");
  });
});
