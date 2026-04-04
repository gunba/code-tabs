import { getNoisyEventKinds } from "./noisyEventKinds";
import type { TapEvent } from "../types/tapEvents";
import type { SessionMetadata, SystemPromptBlock, CapturedMessage } from "../types/session";

// [SI-07] Tool actions, user prompts, assistant text captured inline via event processing
// [IN-11] StatusBar enrichment: model, subscription, region, latency, rate limits, lines changed
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
  private currentEventKind: string | null = null;
  private currentAction: string | null = null;
  private nodeSummary: string | null = null;
  private assistantMessageCount = 0;
  private choiceHint = false;
  private lastFingerprint = "";
  // Context tracking (all from most recent TurnStart)
  private lastCacheRead = 0;
  private lastTurnInputTokens = 0;
  private lastCacheCreation = 0;
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
  private fiveHourPercent: number | null = null;
  private fiveHourResetsAt: number | null = null;
  private sevenDayPercent: number | null = null;
  private sevenDayResetsAt: number | null = null;
  // API latency from dedicated HttpPing (GET /v1/models, bypasses CF cache)
  private apiLatencyMs = 0;
  // EMA-smoothed network RTT (total dur minus server processing time)
  private pingRttMs = 0;
  // EMA-smoothed server-side processing time (from x-envoy-upstream-service-time header)
  private serverTimeMs = 0;
  // Sidechain tracking: true when processing subagent events, prevents TurnStart from overwriting main context
  private sidechainActive = false;
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
  private capturedSystemBlocks: SystemPromptBlock[] | null = null;
  private blocksChanged = false;
  private capturedMessages: CapturedMessage[] | null = null;
  private messagesChanged = false;
  private worktreeInfo: SessionMetadata["worktreeInfo"] = null;
  private statusLine: SessionMetadata["statusLine"] = null;

  /** Process an event and return a metadata diff, or null if unchanged. */
  process(event: TapEvent): Partial<SessionMetadata> | null {
    // [IN-25] Sidechain metadata gating: update sidechainActive early from ConversationMessage
    // so the very first sidechain event doesn't leak into parent's currentEventKind
    if (event.kind === "ConversationMessage") {
      this.sidechainActive = (event as { isSidechain: boolean }).isSidechain;
    }
    if (!getNoisyEventKinds().has(event.kind) && !this.sidechainActive) {
      this.currentEventKind = event.kind;
    }
    switch (event.kind) {
      case "ApiTelemetry": {
        // Deduplicate: Claude Code may stringify the same telemetry object multiple times
        const telKey = `${event.costUSD}:${event.inputTokens}:${event.outputTokens}:${event.cachedInputTokens}`;
        if (telKey === this.lastTelemetryKey) break;
        this.lastTelemetryKey = telKey;
        // [IN-14] Model bleed fix: only update runtimeModel when queryDepth===0
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
        // Only update from main session turns (not subagent sidechain turns)
        if (!this.sidechainActive) {
          this.lastCacheRead = event.cacheRead;
          this.lastTurnInputTokens = event.inputTokens;
          this.lastCacheCreation = event.cacheCreation;
          this.hookStatus = null;
          this.activeSubprocess = null;
          this.lastToolDurationMs = null;
          this.lastToolResultSize = null;
          this.lastToolError = null;
          this.apiErrorStatus = null;
          this.apiRetryInfo = null;
          this.hookTelemetry = null;
        }
        break;

      case "ToolCallStart":
        if (this.sidechainActive) break;
        this.currentToolName = event.toolName;
        // [SI-06] choiceHint: AskUserQuestion sets choiceHint, cleared on UserInput/TurnEnd/PermissionApproved
        // [IN-09] choiceHint detection via ToolCallStart with toolName=AskUserQuestion
        if (event.toolName === "AskUserQuestion") this.choiceHint = true;
        break;

      case "ToolInput": {
        if (this.sidechainActive) break;
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
        this.sidechainActive = event.isSidechain;
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
        // Tool errors → transient status (parent only)
        if (event.hasToolError && event.toolErrorText && !event.isSidechain) {
          this.hookStatus = "Error: " + event.toolErrorText.slice(0, 60);
        }
        break;

      case "TurnEnd":
        if (this.sidechainActive) break;
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

      // API region from cf-ray header; rate-limit tracking; latency from round-trip time
      case "ApiFetch": {
        const h = event.headers;
        const cfRay = h["cf-ray"] || "";
        if (cfRay) {
          const dash = cfRay.lastIndexOf("-");
          if (dash > 0) this.apiRegion = cfRay.slice(dash + 1);
        }
        if (h["request-id"]) this.lastRequestId = h["request-id"];
        if (h["x-ratelimit-limit-tokens"]) this.rateLimitRemaining = h["x-ratelimit-limit-tokens"];
        if (h["x-ratelimit-reset-tokens"]) this.rateLimitReset = h["x-ratelimit-reset-tokens"];
        // [IN-27] Unified rate limit headers from Anthropic API
        const u5h = h["anthropic-ratelimit-unified-5h-utilization"];
        const r5h = h["anthropic-ratelimit-unified-5h-reset"];
        if (u5h) this.fiveHourPercent = parseFloat(u5h) * 100;
        if (r5h) this.fiveHourResetsAt = parseInt(r5h);
        const u7d = h["anthropic-ratelimit-unified-7d-utilization"];
        const r7d = h["anthropic-ratelimit-unified-7d-reset"];
        if (u7d) this.sevenDayPercent = parseFloat(u7d) * 100;
        if (r7d) this.sevenDayResetsAt = parseInt(r7d);
        if (event.durationMs > 0) this.apiLatencyMs = event.durationMs;
        // [IN-28] Decompose total duration into network RTT + server processing
        const envoyMs = parseInt(h["x-envoy-upstream-service-time"] || "0") || 0;
        if (event.durationMs > 0) {
          const EMA = 0.3;
          if (envoyMs > 0) {
            const rtt = Math.max(0, event.durationMs - envoyMs);
            this.pingRttMs = this.pingRttMs > 0 ? EMA * rtt + (1 - EMA) * this.pingRttMs : rtt;
            this.serverTimeMs = this.serverTimeMs > 0 ? EMA * envoyMs + (1 - EMA) * this.serverTimeMs : envoyMs;
          } else {
            // No server-timing header (lightweight GET requests) — total dur ≈ RTT
            this.pingRttMs = this.pingRttMs > 0 ? EMA * event.durationMs + (1 - EMA) * this.pingRttMs : event.durationMs;
          }
        }
        break;
      }

      // [IN-18] Dedicated HTTP ping — overrides ApiFetch latency with a cleaner measurement
      case "HttpPing":
        if (event.durationMs > 0) this.apiLatencyMs = event.durationMs;
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

      // Hook progress (parent only)
      case "HookProgress":
        if (this.sidechainActive) break;
        this.hookStatus = event.statusMessage || event.command || null;
        break;

      // Rate limit warning
      case "RateLimit":
        if (event.status === "allowed_warning") {
          this.hookStatus = `Rate limit warning — resets in ${event.hoursTillReset}h`;
        }
        break;

      // Subprocess spawn → active indicator (parent only)
      case "SubprocessSpawn": {
        if (this.sidechainActive) break;
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
        if (this.sidechainActive) break;
        this.lastToolDurationMs = event.durationMs;
        this.lastToolResultSize = event.toolResultSizeBytes;
        this.lastToolError = event.error;
        if (event.toolName === "AskUserQuestion") this.choiceHint = false;
        break;

      case "LinesChanged":
        if (this.sidechainActive) break;
        this.linesAdded += event.linesAdded;
        this.linesRemoved += event.linesRemoved;
        break;

      case "ApiStreamError":
      case "ApiError":
        if (this.sidechainActive) break;
        this.apiErrorStatus = event.status;
        break;

      case "ApiRetry":
        if (this.sidechainActive) break;
        this.apiRetryCount++;
        this.apiRetryInfo = {
          attempt: event.attempt,
          delayMs: event.delayMs,
          status: event.status,
        };
        break;

      case "StreamStall":
        if (this.sidechainActive) break;
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
        if (this.sidechainActive) break;
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

      case "SystemPromptCapture": // [IN-19] stores capturedSystemPrompt + capturedSystemBlocks + capturedMessages
        if (event.text !== this.capturedSystemPrompt) {
          this.capturedSystemPrompt = event.text;
        }
        if (event.blocks) {
          this.capturedSystemBlocks = event.blocks;
          this.blocksChanged = true;
        }
        if (event.messages) {
          this.capturedMessages = event.messages;
          this.messagesChanged = true;
        }
        break;

      case "StatusLineUpdate":
        // [SI-25] Status line data capture: stored as grouped nullable statusLine object
        this.statusLine = {
          cliVersion: event.cliVersion,
          outputStyle: event.outputStyle,
          totalDurationMs: event.totalDurationMs,
          totalApiDurationMs: event.totalApiDurationMs,
          totalLinesAdded: event.totalLinesAdded,
          totalLinesRemoved: event.totalLinesRemoved,
          totalInputTokens: event.totalInputTokens,
          totalOutputTokens: event.totalOutputTokens,
          totalCostUsd: event.totalCostUsd,
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

      // Hook events — extract metadata-enriching fields (parent only)
      case "PreCompactEvent":
      case "PostCompactEvent":
        if (this.sidechainActive) break;
        this.currentAction = event.kind === "PreCompactEvent" ? "compacting..." : null;
        break;

      case "CwdChangedEvent":
        // CWD change is informational — accumulate for metadata visibility
        break;

      case "TaskCreatedEvent":
      case "TaskCompletedEvent":
        if (this.sidechainActive) break;
        this.currentAction = event.kind === "TaskCreatedEvent"
          ? `task: ${event.taskSubject}`
          : null;
        break;

      default:
        break;
    }

    return this.diff();
  }

  /** Return metadata if changed since last call, otherwise null. */
  private diff(): Partial<SessionMetadata> | null {
    const contextTokens = this.lastTurnInputTokens + this.lastCacheRead + this.lastCacheCreation;
    const contextDebug: SessionMetadata["contextDebug"] = contextTokens > 0
      ? {
          inputTokens: this.lastTurnInputTokens,
          cacheRead: this.lastCacheRead,
          cacheCreation: this.lastCacheCreation,
          totalContextTokens: contextTokens,
          model: this.runtimeModel,
          source: "turnStart" as const,
        }
      : null;

    const metadata: Partial<SessionMetadata> = {
      costUsd: this.costUsd,
      contextDebug,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      currentAction: this.currentAction,
      currentToolName: this.currentToolName,
      currentEventKind: this.currentEventKind,
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
      fiveHourPercent: this.fiveHourPercent,
      fiveHourResetsAt: this.fiveHourResetsAt,
      sevenDayPercent: this.sevenDayPercent,
      sevenDayResetsAt: this.sevenDayResetsAt,
      apiLatencyMs: this.apiLatencyMs,
      pingRttMs: this.pingRttMs,
      serverTimeMs: this.serverTimeMs,
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
    // Include blocks and messages in the returned metadata but NOT in the fingerprint
    // to avoid serializing large prompt/message text on every event
    if (this.capturedSystemBlocks) {
      metadata.capturedSystemBlocks = this.capturedSystemBlocks;
    }
    if (this.capturedMessages) {
      metadata.capturedMessages = this.capturedMessages;
    }
    const blocksJustChanged = this.blocksChanged;
    const messagesJustChanged = this.messagesChanged;
    this.blocksChanged = false;
    this.messagesChanged = false;
    if (fp === this.lastFingerprint && !blocksJustChanged && !messagesJustChanged) return null;
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
    this.currentEventKind = null;
    this.currentAction = null;
    this.nodeSummary = null;
    this.assistantMessageCount = 0;
    this.choiceHint = false;
    this.lastFingerprint = "";
    this.lastCacheRead = 0;
    this.lastTurnInputTokens = 0;
    this.lastCacheCreation = 0;
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
    this.fiveHourPercent = null;
    this.fiveHourResetsAt = null;
    this.sevenDayPercent = null;
    this.sevenDayResetsAt = null;
    this.apiLatencyMs = 0;
    this.pingRttMs = 0;
    this.serverTimeMs = 0;
    this.sidechainActive = false;
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
    this.capturedSystemBlocks = null;
    this.blocksChanged = false;
    this.capturedMessages = null;
    this.messagesChanged = false;
    this.worktreeInfo = null;
    this.statusLine = null;
  }
}
