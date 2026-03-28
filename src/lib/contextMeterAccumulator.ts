import type { TapEvent } from "../types/tapEvents";
import type { SessionMetadata } from "../types/session";
import type {
  ToolCallRecord,
  FileMetrics,
  ModelTokenBreakdown,
  CacheSnapshot,
  ToolBreakdown,
  ContextMeterData,
} from "../types/contextMeter";
import { modelLabel } from "./claude";

const TOOL_CALL_CAP = 500;
const CACHE_HISTORY_CAP = 100;

/**
 * Accumulates context meter data from tap events.
 * One instance per session. Pull-based: call snapshot() on demand.
 */
export class ContextMeterAccumulator {
  private pendingToolInput: { toolName: string; filePath: string | null; ts: number } | null = null;
  private recentToolCalls: ToolCallRecord[] = [];
  private fileMetrics = new Map<string, FileMetrics>();
  private modelBreakdowns = new Map<string, ModelTokenBreakdown>();
  private toolBreakdowns = new Map<string, ToolBreakdown>();

  // Cache tracking
  private totalCachedInputTokens = 0;
  private totalUncachedInputTokens = 0;
  private lastCacheRead = 0;
  private lastCacheCreation = 0;
  private cacheHistory: CacheSnapshot[] = [];
  private turnIndex = 0;
  // Pending TurnStart cache data waiting to be paired with ApiTelemetry
  private pendingTurnCache: { cacheRead: number; cacheCreation: number; ts: number } | null = null;

  // Dedup: same as TapMetadataAccumulator
  private lastTelemetryKey = "";

  process(event: TapEvent): void {
    switch (event.kind) {
      case "ToolInput": {
        const fp = event.input.file_path;
        this.pendingToolInput = {
          toolName: event.toolName,
          filePath: typeof fp === "string" ? fp : null,
          ts: Date.now(),
        };
        break;
      }

      case "ToolResult": {
        const pending = this.pendingToolInput;

        // Create tool call record (paired if possible)
        const record: ToolCallRecord = {
          ts: Date.now(),
          toolName: event.toolName,
          filePath: pending?.toolName === event.toolName ? pending.filePath : null,
          resultSizeBytes: event.toolResultSizeBytes,
          durationMs: event.durationMs,
          error: event.error !== null,
        };

        // Ring buffer push
        if (this.recentToolCalls.length >= TOOL_CALL_CAP) {
          this.recentToolCalls.shift();
        }
        this.recentToolCalls.push(record);

        // Update file metrics if we have a file path from the paired input
        const filePath = record.filePath;
        if (filePath && pending) {
          const existing = this.fileMetrics.get(filePath);
          if (existing) {
            if (pending.toolName === "Read") existing.readCount++;
            else if (pending.toolName === "Write") existing.writeCount++;
            else if (pending.toolName === "Edit") existing.editCount++;
            existing.cumulativeResultBytes += event.toolResultSizeBytes;
            existing.lastAccessTs = Date.now();
          } else {
            this.fileMetrics.set(filePath, {
              filePath,
              readCount: pending.toolName === "Read" ? 1 : 0,
              writeCount: pending.toolName === "Write" ? 1 : 0,
              editCount: pending.toolName === "Edit" ? 1 : 0,
              cumulativeResultBytes: event.toolResultSizeBytes,
              lastAccessTs: Date.now(),
            });
          }
        }

        // Update tool breakdown
        const tb = this.toolBreakdowns.get(event.toolName);
        if (tb) {
          tb.callCount++;
          tb.totalResultBytes += event.toolResultSizeBytes;
          tb.totalDurationMs += event.durationMs;
          if (event.error !== null) tb.errorCount++;
        } else {
          this.toolBreakdowns.set(event.toolName, {
            toolName: event.toolName,
            callCount: 1,
            totalResultBytes: event.toolResultSizeBytes,
            totalDurationMs: event.durationMs,
            errorCount: event.error !== null ? 1 : 0,
          });
        }

        this.pendingToolInput = null;
        break;
      }

      case "TurnStart":
        this.turnIndex++;
        this.lastCacheRead = event.cacheRead;
        this.lastCacheCreation = event.cacheCreation;
        this.pendingTurnCache = {
          cacheRead: event.cacheRead,
          cacheCreation: event.cacheCreation,
          ts: Date.now(),
        };
        break;

      case "ApiTelemetry": {
        // Deduplicate (same logic as TapMetadataAccumulator)
        const telKey = `${event.costUSD}:${event.inputTokens}:${event.outputTokens}:${event.cachedInputTokens}`;
        if (telKey === this.lastTelemetryKey) break;
        this.lastTelemetryKey = telKey;

        // Accumulate cache totals (all depths — main + subagent)
        this.totalCachedInputTokens += event.cachedInputTokens;
        this.totalUncachedInputTokens += event.uncachedInputTokens;

        // Update model breakdown
        const model = event.model;
        const mb = this.modelBreakdowns.get(model);
        if (mb) {
          mb.inputTokens += event.inputTokens + event.cachedInputTokens;
          mb.outputTokens += event.outputTokens;
          mb.cachedInputTokens += event.cachedInputTokens;
          mb.uncachedInputTokens += event.uncachedInputTokens;
          mb.costUsd += event.costUSD;
          mb.callCount++;
        } else {
          this.modelBreakdowns.set(model, {
            model,
            label: modelLabel(model),
            inputTokens: event.inputTokens + event.cachedInputTokens,
            outputTokens: event.outputTokens,
            cachedInputTokens: event.cachedInputTokens,
            uncachedInputTokens: event.uncachedInputTokens,
            costUsd: event.costUSD,
            callCount: 1,
          });
        }

        // Push cache history snapshot (pair with pending TurnStart if available)
        if (this.pendingTurnCache) {
          const snap: CacheSnapshot = {
            ts: this.pendingTurnCache.ts,
            turnIndex: this.turnIndex,
            cacheRead: this.pendingTurnCache.cacheRead,
            cacheCreation: this.pendingTurnCache.cacheCreation,
            cachedInputTokens: event.cachedInputTokens,
            uncachedInputTokens: event.uncachedInputTokens,
          };
          if (this.cacheHistory.length >= CACHE_HISTORY_CAP) {
            this.cacheHistory.shift();
          }
          this.cacheHistory.push(snap);
          this.pendingTurnCache = null;
        }
        break;
      }

      case "UserInput":
      case "SlashCommand":
        // Clear pending to prevent cross-turn mispairing
        this.pendingToolInput = null;
        break;

      default:
        break;
    }
  }

  /** Produce a snapshot for the modal. Reads canonical values from SessionMetadata. */
  snapshot(sessionId: string, sessionName: string, metadata: SessionMetadata): ContextMeterData {
    const totalCached = this.totalCachedInputTokens;
    const totalUncached = this.totalUncachedInputTokens;
    const totalInput = totalCached + totalUncached;
    const cacheHitRate = totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0;

    // Sort hot files desc by cumulative result bytes
    const hotFiles = [...this.fileMetrics.values()]
      .sort((a, b) => b.cumulativeResultBytes - a.cumulativeResultBytes);

    // Sort model breakdowns desc by total tokens (input + output)
    const modelBreakdowns = [...this.modelBreakdowns.values()]
      .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

    // Sort tool breakdowns desc by total result bytes
    const toolBreakdowns = [...this.toolBreakdowns.values()]
      .sort((a, b) => b.totalResultBytes - a.totalResultBytes);

    return {
      sessionId,
      sessionName,
      contextPercent: metadata.contextPercent,
      totalInputTokens: metadata.inputTokens,
      totalOutputTokens: metadata.outputTokens,
      totalCostUsd: metadata.costUsd,
      totalCachedInputTokens: totalCached,
      totalUncachedInputTokens: totalUncached,
      cacheHitRate,
      lastCacheRead: this.lastCacheRead,
      lastCacheCreation: this.lastCacheCreation,
      cacheHistory: [...this.cacheHistory],
      modelBreakdowns,
      toolBreakdowns,
      hotFiles,
      recentToolCalls: [...this.recentToolCalls],
    };
  }

  reset(): void {
    this.pendingToolInput = null;
    this.recentToolCalls = [];
    this.fileMetrics.clear();
    this.modelBreakdowns.clear();
    this.toolBreakdowns.clear();
    this.totalCachedInputTokens = 0;
    this.totalUncachedInputTokens = 0;
    this.lastCacheRead = 0;
    this.lastCacheCreation = 0;
    this.cacheHistory = [];
    this.turnIndex = 0;
    this.pendingTurnCache = null;
    this.lastTelemetryKey = "";
  }
}

/** Module-level registry — modal reads from here on demand. */
export const contextMeterAccumulators = new Map<string, ContextMeterAccumulator>();
