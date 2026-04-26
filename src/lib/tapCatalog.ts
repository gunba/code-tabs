import type { TapCategory } from "./inspectorHooks";
import type { TapEntry } from "../types/tapEvents";

export interface TapCategoryMeta {
  key: TapCategory;
  label: string;
  group: string;
  hookSource: string;
  locked?: boolean;
}

export interface RecordedTapEntry extends Omit<TapEntry, "cat"> {
  tsIso: string;
  hookLabel: string;
  hookSource: string;
}

export const TAP_CATEGORY_GROUPS: Array<{
  label: string;
  categories: TapCategoryMeta[];
}> = [
  {
    label: "Core (always on)",
    categories: [
      { key: "parse", label: "JSON.parse (SSE)", group: "core", hookSource: "JSON.parse()", locked: true },
      { key: "stringify", label: "JSON.stringify (requests)", group: "core", hookSource: "JSON.stringify()", locked: true },
    ],
  },
  {
    label: "Process I/O",
    categories: [
      { key: "console", label: "Console Output", group: "io", hookSource: "console.log() / warn() / error()" },
      { key: "stdout", label: "Stdout Writes", group: "io", hookSource: "process.stdout.write()" },
      { key: "stderr", label: "Stderr Writes", group: "io", hookSource: "process.stderr.write()" },
    ],
  },
  {
    label: "File System",
    categories: [
      { key: "fs", label: "File System (sync)", group: "fs", hookSource: "fs.readFileSync() / writeFileSync() / existsSync() / statSync() / readdirSync()" },
      { key: "fspromises", label: "File System (async)", group: "fs", hookSource: "fs.promises.*()" },
      { key: "bunfile", label: "Bun File Reads", group: "fs", hookSource: "Bun.file().text() / json() / exists()" },
      { key: "fswatch", label: "File Watching", group: "fs", hookSource: "fs.watch() / watchFile()" },
    ],
  },
  {
    label: "Network",
    categories: [
      { key: "fetch", label: "HTTP / Fetch", group: "net", hookSource: "globalThis.fetch() / https.request()" },
      { key: "websocket", label: "WebSocket", group: "net", hookSource: "WebSocket()" },
      { key: "net", label: "TCP / TLS", group: "net", hookSource: "net.createConnection() / tls.connect()" },
      { key: "stream", label: "Stream Piping", group: "net", hookSource: "Readable.prototype.pipe()" },
      { key: "textdecoder", label: "SSE Decoder", group: "net", hookSource: "TextDecoder.prototype.decode()" },
      { key: "abort", label: "Abort Signals", group: "net", hookSource: "AbortController.prototype.abort()" },
    ],
  },
  {
    label: "Process Lifecycle",
    categories: [
      { key: "spawn", label: "Subprocess Spawns", group: "process", hookSource: "child_process.spawn() / exec() / spawnSync() / execSync()" },
      { key: "exit", label: "Process Exit", group: "process", hookSource: "process.exit()" },
      { key: "timer", label: "Timers", group: "process", hookSource: "setTimeout() / clearTimeout() / setInterval() / clearInterval()" },
      { key: "require", label: "Module Loads", group: "process", hookSource: "require()" },
      { key: "bun", label: "Bun Runtime", group: "process", hookSource: "Bun.write() / spawn() / spawnSync()" },
    ],
  },
  {
    label: "Codex Rollout",
    categories: [
      { key: "system-prompt", label: "Prompt Capture", group: "codex", hookSource: "Claude system prompt hook / Codex rollout prompt context" },
      { key: "codex-session", label: "Codex Session", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl session_meta" },
      { key: "codex-turn-context", label: "Codex Turn Context", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl turn_context" },
      { key: "codex-token-count", label: "Codex Token Counts", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl token_count" },
      { key: "codex-tool-call-start", label: "Codex Tool Starts", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl response_item function_call" },
      { key: "codex-tool-input", label: "Codex Tool Inputs", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl tool arguments" },
      { key: "codex-tool-call-complete", label: "Codex Tool Results", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl tool output" },
      { key: "codex-message", label: "Codex Messages", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl messages" },
      { key: "codex-thread-name-updated", label: "Codex Thread Names", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl thread_name_updated" },
      { key: "codex-compacted", label: "Codex Compaction", group: "codex", hookSource: "$CODEX_HOME/sessions/.../rollout-*.jsonl compacted" },
    ],
  },
  {
    label: "Internals",
    categories: [
      { key: "events", label: "Event Emitters", group: "internal", hookSource: "EventEmitter.prototype.emit()" },
      { key: "envproxy", label: "Environment Access", group: "internal", hookSource: "process.env reads" },
    ],
  },
];

const META_BY_KEY: Record<string, TapCategoryMeta> = Object.fromEntries(
  TAP_CATEGORY_GROUPS.flatMap((group) => group.categories.map((category) => [category.key, category])),
);

function truncate(value: string, max = 140): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function getTapCategoryMeta(key: string): TapCategoryMeta {
  return META_BY_KEY[key] ?? {
    key: key as TapCategory,
    label: key,
    group: "other",
    hookSource: key,
  };
}

export function getTapCategoryLabel(key: string): string {
  return getTapCategoryMeta(key).label;
}

export function describeTapEntrySource(entry: TapEntry): string {
  const op = typeof entry.op === "string" ? entry.op : null;
  switch (entry.cat) {
    case "console":
      return op ? `console.${op}()` : "console.*";
    case "spawn":
      return op ? `child_process.${op}()` : "child_process.*";
    case "bun":
      return op ? `Bun.${op}()` : "Bun.*";
    case "fspromises":
      return op ? `fs.promises.${op}()` : "fs.promises.*";
    case "bunfile":
      return op ? `Bun.file().${op}()` : "Bun.file()";
    case "timer":
      return op ? `${op}()` : "timer";
    case "fetch":
      return op === "https-resp" ? "https.request()" : "fetch()";
    case "websocket":
      return op ? `WebSocket.${op}` : "WebSocket";
    default:
      return getTapCategoryMeta(entry.cat).hookSource;
  }
}

export function annotateTapEntry(entry: TapEntry): RecordedTapEntry {
  const { cat: _cat, ...rest } = entry;
  return {
    ...rest,
    tsIso: new Date(entry.ts).toISOString(),
    hookLabel: getTapCategoryLabel(entry.cat),
    hookSource: truncate(describeTapEntrySource(entry)),
  };
}
