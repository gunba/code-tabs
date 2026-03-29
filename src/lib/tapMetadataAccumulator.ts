import type { TapEvent } from "../types/tapEvents";
import type { SessionMetadata } from "../types/session";

/**
 * Stateful accumulator: processes tap events and produces metadata diffs.
 * One instance per session. Fingerprint-based diffing — only returns changes.
 */
export class TapMetadataAccumulator {
  private costUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private runtimeModel: string | null = null;
  private currentToolName: string | null = null;
  private currentAction: string | null = null;
  private nodeSummary: string | null = null;
  private assistantMessageCount = 0;
  private choiceHint = false;
  private lastFingerprint = "";
  // Context tracking
  private lastCacheRead = 0;
  // API region + request ID
  private apiRegion: string | null = null;
  private lastRequestId: string | null = null;
  // API request structure
  private systemPromptLength = 0;
  private toolCount = 0;
  private conversationLength = 0;
  // Subscription tier
  private subscriptionType: string | null = null;
  // Hook/transient status
  private hookStatus: string | null = null;
  // Per-turn cost + TTFT
  private lastTurnCostUsd = 0;
  private lastTurnTtftMs = 0;
  // Active subprocess
  private activeSubprocess: string | null = null;
  // Files touched
  private filesTouched = new Set<string>();
  // Rate limits
  private rateLimitRemaining: string | null = null;
  private rateLimitReset: string | null = null;
  // API latency (time-to-headers from ApiFetch)
  private apiLatencyMs: number | null = null;
  // Dedup: skip consecutive identical ApiTelemetry (stringify can serialize the same object multiple times)
  private lastTelemetryKey = "";
  // TAP pipeline expansion
  private linesAdded = 0;
  private linesRemoved = 0;
  private lastToolDurationMs: number | null = null;
  private lastToolResultSize: number | null = null;
  private lastToolError: string | null = null;
  private apiRetryCount = 0;
  private apiErrorStatus: number | null = null;
  private apiRetryInfo: SessionMetadata["apiRetryInfo"] = null;
  private stallDurationMs = 0;
  private stallCount = 0;
  private contextBudget: SessionMetadata["contextBudget"] = null;
  private hookTelemetry: SessionMetadata["hookTelemetry"] = null;
  private planOutcome: string | null = null;
  private effortLevel: string | null = null;
  private capturedSystemPrompt: string | null = null;
  private worktreeInfo: SessionMetadata["worktreeInfo"] = null;
  private statusLine: SessionMetadata["statusLine"] = null;

  /** Process an event and return a metadata diff, or null if unchanged. */
  process(event: TapEvent): Partial<SessionMetadata> | null {
    switch (event.kind) {
      case "ApiTelemetry": {
        // Deduplicate: Claude Code may stringify the same telemetry object multiple times
        const telKey = `${event.costUSD}:${event.inputTokens}:${event.outputTokens}:${event.cachedInputTokens}`;
        if (telKey === this.lastTelemetryKey) break;
        this.lastTelemetryKey = telKey;
        // Only accumulate main-agent tokens/cost (subagent tokens tracked by TapSubagentTracker)
        if (event.queryDepth === 0) {
          this.costUsd += event.costUSD;
          this.inputTokens += event.inputTokens + event.cachedInputTokens;
          this.outputTokens += event.outputTokens;
          this.lastTurnCostUsd = event.costUSD;
          this.lastTurnTtftMs = event.ttftMs;
        }
        if (event.model && event.queryDepth === 0) this.runtimeModel = event.model;
        break;
      }

      case "TurnStart":
        // Initializer-only: set model from first TurnStart, don't let subagent TurnStart overwrite
        if (event.model && !this.runtimeModel) this.runtimeModel = event.model;
        this.lastCacheRead = event.cacheRead;
        this.hookStatus = null;
        this.activeSubprocess = null;
        this.lastToolDurationMs = null;
        this.lastToolResultSize = null;
        this.lastToolError = null;
        this.apiErrorStatus = null;
        this.apiRetryInfo = null;
        this.hookTelemetry = null;
        break;

      case "ToolCallStart":
        this.currentToolName = event.toolName;
        if (event.toolName === "AskUserQuestion") this.choiceHint = true;
        break;

      case "ToolInput": {
        this.currentAction = event.toolName + ": " + String(
          event.input.command || event.input.file_path || event.input.pattern ||
          event.input.description || event.input.query || ""
        ).slice(0, 80);
        // Track file paths for Edit/Write/Read
        const fp = event.input.file_path;
        if (typeof fp === "string" && (event.toolName === "Edit" || event.toolName === "Write" || event.toolName === "Read")) {
          this.filesTouched.add(fp);
        }
        break;
      }

      case "UserInput":
      case "SlashCommand":
        if (!this.nodeSummary) {
          this.nodeSummary = event.display.slice(0, 200);
        }
        this.currentToolName = null;
        this.currentAction = null;
        this.choiceHint = false;
        this.hookStatus = null;
        this.activeSubprocess = null;
        this.lastToolDurationMs = null;
        this.lastToolResultSize = null;
        this.lastToolError = null;
        this.apiErrorStatus = null;
        this.apiRetryInfo = null;
        this.planOutcome = null;
        break;

      case "ConversationMessage":
        if (event.messageType === "assistant" && !event.isSidechain) {
          this.assistantMessageCount++;
          if (event.toolAction) this.currentAction = event.toolAction;
          if (event.toolNames.length > 0) {
            this.currentToolName = event.toolNames[event.toolNames.length - 1];
          }
        }
        if (event.messageType === "user" && !event.isSidechain && event.textSnippet) {
          if (!this.nodeSummary) {
            this.nodeSummary = event.textSnippet.slice(0, 200);
          }
        }
        // Tool errors → transient status
        if (event.hasToolError && event.toolErrorText) {
          this.hookStatus = "Error: " + event.toolErrorText.slice(0, 60);
        }
        break;

      case "TurnEnd":
        if (event.stopReason === "end_turn") {
          this.currentToolName = null;
          this.currentAction = null;
          this.choiceHint = false;
          this.activeSubprocess = null;
        }
        break;

      case "PermissionApproved":
      case "PermissionRejected":
        this.choiceHint = false;
        break;

      // API region from cf-ray header
      case "ApiFetch":
        if (event.cfRay) {
          const dash = event.cfRay.lastIndexOf("-");
          if (dash > 0) this.apiRegion = event.cfRay.slice(dash + 1);
          if (event.durationMs > 0) this.apiLatencyMs = event.durationMs; // 0 = missing/default, not a real measurement
        }
        if (event.requestId) this.lastRequestId = event.requestId;
        if (event.rateLimitRemaining) this.rateLimitRemaining = event.rateLimitRemaining;
        if (event.rateLimitReset) this.rateLimitReset = event.rateLimitReset;
        break;

      // API request structure
      case "ApiRequestInfo":
        this.systemPromptLength = event.systemLength;
        this.toolCount = event.toolCount;
        this.conversationLength = event.messageCount;
        break;

      // Subscription tier
      case "AccountInfo":
        this.subscriptionType = event.subscriptionType;
        break;

      // Hook progress
      case "HookProgress":
        this.hookStatus = event.statusMessage || event.command || null;
        break;

      // Rate limit warning
      case "RateLimit":
        if (event.status === "allowed_warning") {
          this.hookStatus = `Rate limit warning — resets in ${event.hoursTillReset}h`;
        }
        break;

      // Subprocess spawn → active indicator
      case "SubprocessSpawn": {
        const cmd = event.cmd;
        // Extract a short label: last path segment + eval'd command if bash
        const evalMatch = cmd.match(/eval '([^']+)'/);
        if (evalMatch) {
          this.activeSubprocess = evalMatch[1].slice(0, 40);
        } else {
          const parts = cmd.split(/[\\/]/);
          const exe = parts[parts.length - 1]?.split(" ")[0] || cmd.slice(0, 30);
          this.activeSubprocess = exe;
        }
        break;
      }

      // File history snapshot → merge into filesTouched
      case "FileHistorySnapshot":
        for (const p of event.filePaths) {
          this.filesTouched.add(p);
        }
        break;

      case "ToolResult":
        this.lastToolDurationMs = event.durationMs;
        this.lastToolResultSize = event.toolResultSizeBytes;
        this.lastToolError = event.error;
        break;

      case "LinesChanged":
        this.linesAdded += event.linesAdded;
        this.linesRemoved += event.linesRemoved;
        break;

      case "ApiStreamError":
      case "ApiError":
        this.apiErrorStatus = event.status;
        break;

      case "ApiRetry":
        this.apiRetryCount++;
        this.apiRetryInfo = {
          attempt: event.attempt,
          delayMs: event.delayMs,
          status: event.status,
        };
        break;

      case "StreamStall":
        this.stallDurationMs += event.stallDurationMs;
        this.stallCount++;
        break;

      case "ContextBudget":
        this.contextBudget = {
          claudeMdSize: event.claudeMdSize,
          totalContextSize: event.totalContextSize,
          mcpToolsCount: event.mcpToolsCount,
          mcpToolsTokens: event.mcpToolsTokens,
          nonMcpToolsCount: event.nonMcpToolsCount,
          nonMcpToolsTokens: event.nonMcpToolsTokens,
          projectFileCount: event.projectFileCount,
        };
        break;

      case "HookTelemetry":
        this.hookTelemetry = {
          hookName: event.hookName,
          numCommands: event.numCommands,
          numSuccess: event.numSuccess,
          numErrors: event.numErrors,
          durationMs: event.totalDurationMs,
        };
        this.hookStatus = `${event.hookName}: ${event.numSuccess}/${event.numCommands} (${event.totalDurationMs}ms)`;
        break;

      case "PlanModeEvent":
        this.planOutcome = event.outcome;
        break;

      case "EffortLevel":
        this.effortLevel = event.level;
        break;

      case "WorktreeState":
        this.worktreeInfo = {
          originalCwd: event.originalCwd,
          worktreePath: event.worktreePath,
          worktreeName: event.worktreeName,
          worktreeBranch: event.worktreeBranch,
        };
        break;

      case "WorktreeCleared":
        this.worktreeInfo = null;
        break;

      case "SystemPromptCapture":
        if (event.text !== this.capturedSystemPrompt) {
          this.capturedSystemPrompt = event.text;
        }
        break;

      case "StatusLineUpdate":
        this.statusLine = {
          cliVersion: event.cliVersion,
          outputStyle: event.outputStyle,
          totalDurationMs: event.totalDurationMs,
          totalApiDurationMs: event.totalApiDurationMs,
          totalLinesAdded: event.totalLinesAdded,
          totalLinesRemoved: event.totalLinesRemoved,
          contextWindowSize: event.contextWindowSize,
          contextUsedPercent: event.contextUsedPercent,
          contextRemainingPercent: event.contextRemainingPercent,
          exceeds200kTokens: event.exceeds200kTokens,
          currentInputTokens: event.currentInputTokens,
          currentOutputTokens: event.currentOutputTokens,
          cacheCreationInputTokens: event.cacheCreationInputTokens,
          cacheReadInputTokens: event.cacheReadInputTokens,
          fiveHourUsedPercent: event.fiveHourUsedPercent,
          fiveHourResetsAt: event.fiveHourResetsAt,
          sevenDayUsedPercent: event.sevenDayUsedPercent,
          sevenDayResetsAt: event.sevenDayResetsAt,
          vimMode: event.vimMode,
        };
        break;

      default:
        return null;
    }

    return this.diff();
  }

  /** Return metadata if changed since last call, otherwise null. */
  private diff(): Partial<SessionMetadata> | null {
    const denominator = this.contextBudget?.totalContextSize || 200000;
    const contextPercent = this.lastCacheRead > 0
      ? Math.min(99, Math.round((this.lastCacheRead / denominator) * 100))
      : 0;

    const metadata: Partial<SessionMetadata> = {
      costUsd: this.costUsd,
      contextPercent,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      currentAction: this.currentAction,
      currentToolName: this.currentToolName,
      choiceHint: this.choiceHint,
      runtimeModel: this.runtimeModel,
      assistantMessageCount: this.assistantMessageCount,
      apiRegion: this.apiRegion,
      lastRequestId: this.lastRequestId,
      subscriptionType: this.subscriptionType,
      hookStatus: this.hookStatus,
      lastTurnCostUsd: this.lastTurnCostUsd,
      lastTurnTtftMs: this.lastTurnTtftMs,
      systemPromptLength: this.systemPromptLength,
      toolCount: this.toolCount,
      conversationLength: this.conversationLength,
      activeSubprocess: this.activeSubprocess,
      filesTouched: [...this.filesTouched],
      rateLimitRemaining: this.rateLimitRemaining,
      rateLimitReset: this.rateLimitReset,
      apiLatencyMs: this.apiLatencyMs,
      linesAdded: this.linesAdded,
      linesRemoved: this.linesRemoved,
      lastToolDurationMs: this.lastToolDurationMs,
      lastToolResultSize: this.lastToolResultSize,
      lastToolError: this.lastToolError,
      apiRetryCount: this.apiRetryCount,
      apiErrorStatus: this.apiErrorStatus,
      apiRetryInfo: this.apiRetryInfo,
      stallDurationMs: this.stallDurationMs,
      stallCount: this.stallCount,
      contextBudget: this.contextBudget,
      hookTelemetry: this.hookTelemetry,
      planOutcome: this.planOutcome,
      effortLevel: this.effortLevel,
      capturedSystemPrompt: this.capturedSystemPrompt,
      worktreeInfo: this.worktreeInfo,
      statusLine: this.statusLine,
      ...(this.nodeSummary ? { nodeSummary: this.nodeSummary } : {}),
    };

    const fp = JSON.stringify(metadata);
    if (fp === this.lastFingerprint) return null;
    this.lastFingerprint = fp;
    return metadata;
  }

  /** Reset all accumulated state. */
  reset(): void {
    this.costUsd = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.runtimeModel = null;
    this.currentToolName = null;
    this.currentAction = null;
    this.nodeSummary = null;
    this.assistantMessageCount = 0;
    this.choiceHint = false;
    this.lastFingerprint = "";
    this.lastCacheRead = 0;
    this.apiRegion = null;
    this.lastRequestId = null;
    this.systemPromptLength = 0;
    this.toolCount = 0;
    this.conversationLength = 0;
    this.subscriptionType = null;
    this.hookStatus = null;
    this.lastTurnCostUsd = 0;
    this.lastTurnTtftMs = 0;
    this.activeSubprocess = null;
    this.filesTouched.clear();
    this.rateLimitRemaining = null;
    this.rateLimitReset = null;
    this.apiLatencyMs = null;
    this.lastTelemetryKey = "";
    this.linesAdded = 0;
    this.linesRemoved = 0;
    this.lastToolDurationMs = null;
    this.lastToolResultSize = null;
    this.lastToolError = null;
    this.apiRetryCount = 0;
    this.apiErrorStatus = null;
    this.apiRetryInfo = null;
    this.stallDurationMs = 0;
    this.stallCount = 0;
    this.contextBudget = null;
    this.hookTelemetry = null;
    this.planOutcome = null;
    this.effortLevel = null;
    this.capturedSystemPrompt = null;
    this.worktreeInfo = null;
    this.statusLine = null;
  }
}
