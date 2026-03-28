/** Per-tool-call record — kept lean for ring buffer */
export interface ToolCallRecord {
  ts: number;
  toolName: string;
  filePath: string | null;
  resultSizeBytes: number;
  durationMs: number;
  error: boolean;
}

/** Per-file aggregation — the "Hot Files" DPS meter entries */
export interface FileMetrics {
  filePath: string;
  readCount: number;
  writeCount: number;
  editCount: number;
  cumulativeResultBytes: number;
  lastAccessTs: number;
}

/** Per-model token breakdown — caching is first-class */
export interface ModelTokenBreakdown {
  model: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  costUsd: number;
  callCount: number;
}

/** Per-turn cache tracking — trends over time */
export interface CacheSnapshot {
  ts: number;
  turnIndex: number;
  cacheRead: number;
  cacheCreation: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
}

/** Per-tool aggregation */
export interface ToolBreakdown {
  toolName: string;
  callCount: number;
  totalResultBytes: number;
  totalDurationMs: number;
  errorCount: number;
}

/** Full snapshot for the modal */
export interface ContextMeterData {
  sessionId: string;
  sessionName: string;
  contextPercent: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  // Cache summary
  totalCachedInputTokens: number;
  totalUncachedInputTokens: number;
  cacheHitRate: number;
  lastCacheRead: number;
  lastCacheCreation: number;
  cacheHistory: CacheSnapshot[];
  // Breakdowns
  modelBreakdowns: ModelTokenBreakdown[];
  toolBreakdowns: ToolBreakdown[];
  hotFiles: FileMetrics[];
  recentToolCalls: ToolCallRecord[];
}
