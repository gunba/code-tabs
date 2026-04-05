import type { TapEntry, TapEvent } from "../types/tapEvents";
import type { SystemPromptBlock, CapturedMessage } from "../types/session";

/**
 * Shared helper: format tool_use name + input into a human-readable action string.
 * Mirrors fmtToolAction in inspectorHooks.ts INSTALL_HOOK.
 */
const TOOL_ACTION_KEYS: Record<string, string> = {
  Bash: "command", Read: "file_path", Write: "file_path", Edit: "file_path",
  Grep: "pattern", Glob: "pattern", Agent: "description", Skill: "skill",
};

function fmtToolAction(name: string, inp: Record<string, unknown>): string {
  const key = TOOL_ACTION_KEYS[name];
  if (key && inp[key]) return name + ": " + String(inp[key]).slice(0, 80);
  return name;
}

// ── Parse (SSE) classifiers ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyParse(ts: number, parsed: any): TapEvent | null {
  const type = parsed.type;
  if (!type) return null;

  // message_start → TurnStart
  if (type === "message_start" && parsed.message) {
    const msg = parsed.message;
    return {
      kind: "TurnStart", ts,
      model: msg.model || "",
      inputTokens: msg.usage?.input_tokens || 0,
      outputTokens: msg.usage?.output_tokens || 0,
      cacheRead: msg.usage?.cache_read_input_tokens || 0,
      cacheCreation: msg.usage?.cache_creation_input_tokens || 0,
    };
  }

  // content_block_start → ThinkingStart | TextStart | ToolCallStart
  if (type === "content_block_start" && parsed.content_block) {
    const cb = parsed.content_block;
    if (cb.type === "thinking") return { kind: "ThinkingStart", ts, index: parsed.index ?? 0 };
    if (cb.type === "text") return { kind: "TextStart", ts, index: parsed.index ?? 0 };
    if (cb.type === "tool_use") return {
      kind: "ToolCallStart", ts,
      index: parsed.index ?? 0,
      toolName: cb.name || "",
      toolId: cb.id || "",
    };
  }

  // content_block_stop → BlockStop
  if (type === "content_block_stop") {
    return { kind: "BlockStop", ts, index: parsed.index ?? 0 };
  }

  // message_delta → TurnEnd
  if (type === "message_delta" && parsed.delta?.stop_reason) {
    return {
      kind: "TurnEnd", ts,
      stopReason: parsed.delta.stop_reason,
      outputTokens: parsed.usage?.output_tokens || 0,
    };
  }

  // message_stop → MessageStop
  if (type === "message_stop") {
    return { kind: "MessageStop", ts };
  }

  // error — API error during streaming (e.g. 529 overloaded)
  if (type === "error") {
    return {
      kind: "ApiStreamError", ts,
      type: parsed.error?.type || "unknown",
      message: parsed.error?.message || "",
      status: typeof parsed.status === "number" ? parsed.status : null,
    };
  }

  // content_block_delta — high-frequency, NOT classified (disk only)
  return null;
}

// ── Stringify (outgoing) classifiers ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyStringify(ts: number, parsed: any): TapEvent | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  // UserInput: has display + timestamp + project/sessionId
  if (typeof parsed.display === "string" && parsed.timestamp) {
    const display = parsed.display as string;
    if (display.startsWith("/")) {
      return {
        kind: "SlashCommand", ts,
        command: display.split(" ")[0],
        display,
      };
    }
    return {
      kind: "UserInput", ts,
      display,
      sessionId: parsed.sessionId || "",
    };
  }

  // ApiTelemetry: has costUSD + model + durationMs
  if (typeof parsed.costUSD === "number" && typeof parsed.durationMs === "number") {
    return {
      kind: "ApiTelemetry", ts,
      model: parsed.model || "",
      costUSD: parsed.costUSD,
      inputTokens: parsed.inputTokens || 0,
      outputTokens: parsed.outputTokens || 0,
      cachedInputTokens: parsed.cachedInputTokens || 0,
      uncachedInputTokens: parsed.uncachedInputTokens || 0,
      durationMs: parsed.durationMs,
      ttftMs: parsed.ttftMs || 0,
      queryChainId: parsed.queryChainId || null,
      queryDepth: parsed.queryDepth || 0,
      stopReason: parsed.stop_reason || null,
    };
  }

  // ProcessHealth: has rss + heapUsed + uptime
  if (typeof parsed.rss === "number" && typeof parsed.heapUsed === "number" && typeof parsed.uptime === "number") {
    return {
      kind: "ProcessHealth", ts,
      rss: parsed.rss,
      heapUsed: parsed.heapUsed,
      heapTotal: parsed.heapTotal || 0,
      uptime: parsed.uptime,
      cpuPercent: parsed.cpuPercent || 0,
    };
  }

  // RateLimit: has status + hoursTillReset
  if (typeof parsed.status === "string" && typeof parsed.hoursTillReset === "number") {
    return {
      kind: "RateLimit", ts,
      status: parsed.status,
      hoursTillReset: parsed.hoursTillReset,
    };
  }

  // HookProgress: type=progress with data.type=hook_progress
  if (parsed.type === "progress" && parsed.data?.type === "hook_progress") {
    return {
      kind: "HookProgress", ts,
      hookEvent: parsed.data.hookEvent || "",
      hookName: parsed.data.hookName || "",
      command: parsed.data.command || "",
      statusMessage: parsed.data.statusMessage || "",
    };
  }

  // SessionRegistration: has pid + sessionId + cwd + startedAt
  if (typeof parsed.pid === "number" && parsed.sessionId && parsed.startedAt) {
    return {
      kind: "SessionRegistration", ts,
      pid: parsed.pid,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd || "",
      name: parsed.name || null,
    };
  }

  // CustomTitle: type=custom-title
  if (parsed.type === "custom-title" && parsed.customTitle) {
    return {
      kind: "CustomTitle", ts,
      title: parsed.customTitle,
      sessionId: parsed.sessionId || "",
    };
  }

  // SubagentNotification: type=queue-operation with task-notification XML
  if (parsed.type === "queue-operation" && typeof parsed.content === "string") {
    const content = parsed.content as string;
    const statusMatch = content.match(/<status>(completed|killed)<\/status>/);
    const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);
    if (statusMatch) {
      return {
        kind: "SubagentNotification", ts,
        status: statusMatch[1] as "completed" | "killed",
        summary: summaryMatch ? summaryMatch[1] : "",
      };
    }
  }

  // PermissionPromptShown: setMode array with acceptEdits destination
  if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type === "setMode") {
    return {
      kind: "PermissionPromptShown", ts,
      toolName: null,
    };
  }

  // PermissionPromptShown (telemetry): tengu_tool_use_show_permission_request shape
  if (parsed.toolName && parsed.decisionReasonType !== undefined && parsed.sandboxEnabled !== undefined) {
    return {
      kind: "PermissionPromptShown", ts,
      toolName: parsed.toolName,
    };
  }

  // PermissionApproved (telemetry): tengu_accept_submitted shape
  if (parsed.toolName && parsed.has_instructions !== undefined && parsed.entered_feedback_mode !== undefined) {
    return {
      kind: "PermissionApproved", ts,
      toolName: parsed.toolName,
    };
  }

  // ── rh-based telemetry events (must come BEFORE ModeChange which broadly matches rh + to) ──

  // SubagentEnd scope: definitive subagent completion signal
  if (parsed.rh && parsed.scope === "subagent_end") {
    return {
      kind: "SubagentLifecycle", ts,
      variant: "end",
      agentType: null, isAsync: null, model: null,
      totalTokens: null, totalToolUses: null, durationMs: null, reason: null,
    };
  }

  // ToolResult: tool execution completed with metrics
  if (parsed.rh && parsed.toolName && typeof parsed.durationMs === "number" && parsed.toolResultSizeBytes !== undefined) {
    return {
      kind: "ToolResult", ts,
      toolName: parsed.toolName,
      durationMs: parsed.durationMs,
      toolResultSizeBytes: parsed.toolResultSizeBytes,
      error: parsed.error ? String(parsed.error) : null,
    };
  }

  // ApiRetry: retry attempt for failed API call
  if (parsed.rh && typeof parsed.attempt === "number" && typeof parsed.delayMs === "number" && typeof parsed.status === "number") {
    return {
      kind: "ApiRetry", ts,
      attempt: parsed.attempt,
      delayMs: parsed.delayMs,
      status: parsed.status,
    };
  }

  // StreamStall: API stream stall detected
  if (parsed.rh && typeof parsed.stall_duration_ms === "number") {
    return {
      kind: "StreamStall", ts,
      stallDurationMs: parsed.stall_duration_ms,
      stallCount: parsed.stall_count || 1,
      totalStallTimeMs: parsed.total_stall_time_ms || parsed.stall_duration_ms,
    };
  }

  // LinesChanged: lines added/removed by a tool
  if (parsed.rh && typeof parsed.lines_added === "number" && typeof parsed.lines_removed === "number") {
    return {
      kind: "LinesChanged", ts,
      linesAdded: parsed.lines_added,
      linesRemoved: parsed.lines_removed,
    };
  }

  // ContextBudget: context budget breakdown
  if (parsed.rh && typeof parsed.total_context_size === "number" && parsed.mcp_tools_count !== undefined) {
    return {
      kind: "ContextBudget", ts,
      claudeMdSize: parsed.claude_md_size || 0,
      totalContextSize: parsed.total_context_size,
      mcpToolsCount: parsed.mcp_tools_count || 0,
      mcpToolsTokens: parsed.mcp_tools_tokens || 0,
      nonMcpToolsCount: parsed.non_mcp_tools_count || 0,
      nonMcpToolsTokens: parsed.non_mcp_tools_tokens || 0,
      projectFileCount: parsed.project_file_count_rounded || 0,
    };
  }

  // SubagentLifecycle: subagent start/end/killed telemetry
  if (parsed.rh && parsed.agent_type && (parsed.is_async !== undefined || parsed.total_tokens !== undefined || parsed.reason)) {
    let variant: "start" | "end" | "killed";
    if (parsed.is_async !== undefined) variant = "start";
    else if (parsed.total_tokens !== undefined) variant = "end";
    else variant = "killed";
    return {
      kind: "SubagentLifecycle", ts,
      variant,
      agentType: parsed.agent_type || null,
      isAsync: parsed.is_async ?? null,
      model: parsed.model || null,
      totalTokens: parsed.total_tokens ?? null,
      totalToolUses: parsed.total_tool_uses ?? null,
      durationMs: parsed.duration_ms ?? null,
      reason: parsed.reason || null,
    };
  }

  // PlanModeEvent: plan mode exit with outcome
  if (parsed.rh && typeof parsed.planLengthChars === "number" && parsed.outcome) {
    return {
      kind: "PlanModeEvent", ts,
      planLengthChars: parsed.planLengthChars,
      outcome: parsed.outcome,
    };
  }

  // HookTelemetry: hook execution results
  if (parsed.rh && parsed.hookName && typeof parsed.totalDurationMs === "number" && parsed.numCommands !== undefined) {
    return {
      kind: "HookTelemetry", ts,
      hookName: parsed.hookName,
      totalDurationMs: parsed.totalDurationMs,
      numCommands: parsed.numCommands || 0,
      numSuccess: parsed.numSuccess || 0,
      numErrors: (parsed.numNonBlockingError || 0) + (parsed.numCancelled || 0),
    };
  }

  // ModeChange: has rh + to
  if (parsed.rh && typeof parsed.to === "string") {
    return {
      kind: "ModeChange", ts,
      to: parsed.to,
    };
  }

  // PermissionPromptShown: CLI permission notification (notification_type path)
  if (parsed.notification_type === "permission_prompt") {
    return { kind: "PermissionPromptShown", ts, toolName: null };
  }

  // IdlePrompt: CLI idle notification (authoritative idle signal)
  if (parsed.notification_type === "idle_prompt") {
    return { kind: "IdlePrompt", ts };
  }

  // ConversationMessage: has type in (user, assistant, result) + message or specific structure
  if (parsed.type === "user" || parsed.type === "assistant" || parsed.type === "result") {
    // [IN-17] SkillInvocation: early-return before UserInterruption/PermissionRejected checks
    if (parsed.type === "user" && parsed.toolUseResult?.commandName) {
      return {
        kind: "SkillInvocation", ts,
        skill: parsed.toolUseResult.commandName,
        success: !!parsed.toolUseResult.success,
        allowedTools: parsed.toolUseResult.allowedTools || [],
      };
    }

    // SessionResume: assistant with model "<synthetic>"
    if (parsed.type === "assistant" && parsed.message?.model === "<synthetic>") {
      return { kind: "SessionResume", ts };
    }

    // UserInterruption: user message with interruption text
    if (parsed.type === "user" && parsed.message?.content) {
      const content = parsed.message.content;
      const text = typeof content === "string" ? content :
        Array.isArray(content) ? content.find((c: { type: string; text?: string }) => c.type === "text")?.text : null;
      if (typeof text === "string" && text.includes("[Request interrupted by user")) {
        return {
          kind: "UserInterruption", ts,
          forToolUse: text.includes("for tool use"),
        };
      }
      // PermissionRejected: tool_result with rejection text
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const resultText = typeof block.content === "string" ? block.content :
              Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text || "").join("") : "";
            if (resultText.includes("The user doesn't want to proceed")) {
              return { kind: "PermissionRejected", ts };
            }
          }
        }
      }
    }

    // General ConversationMessage
    const msg = parsed.message;
    const toolNames: string[] = [];
    let toolAction: string | null = null;
    let textSnippet: string | null = null;

    if (parsed.type === "assistant" && msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolNames.push(block.name);
          toolAction = fmtToolAction(block.name, block.input || {});
        }
        if (block.type === "text" && block.text) {
          textSnippet = block.text;
        }
      }
    }

    // Tool error extraction: scan user message content for is_error tool_result blocks
    let hasToolError = false;
    let toolErrorText: string | null = null;
    let toolResultSnippets: Array<{ toolUseId: string; content: string; isError: boolean }> | null = null;
    if (parsed.type === "user" && Array.isArray(parsed.message?.content || parsed.message)) {
      const blocks = Array.isArray(parsed.message?.content) ? parsed.message.content : [];
      for (const block of blocks) {
        if (block?.type === "tool_result") {
          // Extract tool result content for sidechain messages (SubagentInspector)
          const resultText = typeof block.content === "string" ? block.content :
            Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text || "").join("") : "";
          if (!toolResultSnippets) toolResultSnippets = [];
          toolResultSnippets.push({
            toolUseId: block.tool_use_id || "",
            content: resultText.slice(0, 2000),
            isError: !!block.is_error,
          });
          if (block.is_error && !hasToolError) {
            hasToolError = true;
            toolErrorText = resultText.slice(0, 200);
          }
        }
      }
    }

    return {
      kind: "ConversationMessage", ts,
      messageType: parsed.type,
      isSidechain: !!parsed.isSidechain,
      agentId: parsed.agentId || null,
      uuid: parsed.uuid || null,
      parentUuid: parsed.parentUuid || null,
      promptId: parsed.promptId || null,
      stopReason: msg?.stop_reason || null,
      toolNames,
      toolAction,
      textSnippet,
      cwd: parsed.cwd || null,
      hasToolError,
      toolErrorText,
      toolResultSnippets,
    };
  }

  // ApiRequestInfo: API request body (has model + messages array)
  if (parsed.model && Array.isArray(parsed.messages) && !parsed.costUSD) {
    const system = parsed.system;
    let systemLength = 0;
    if (Array.isArray(system)) {
      for (const s of system) systemLength += (s.text?.length || 0);
    } else if (typeof system === "string") {
      systemLength = system.length;
    }
    return {
      kind: "ApiRequestInfo", ts,
      model: parsed.model,
      systemLength,
      toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      messageCount: parsed.messages.length,
    };
  }

  // [IN-15] AccountInfo classifier: guard relaxed to require only billingType (not subscriptionType)
  if (parsed.accountUuid && parsed.billingType) {
    return {
      kind: "AccountInfo", ts,
      subscriptionType: parsed.subscriptionType ?? null,
      rateLimitTier: parsed.rateLimitTier || "",
      billingType: parsed.billingType,
      displayName: parsed.displayName || "",
    };
  }

  // WorktreeState / WorktreeCleared: type=worktree-state
  if (parsed.type === "worktree-state") {
    if (parsed.worktreeSession) {
      const ws = parsed.worktreeSession;
      return {
        kind: "WorktreeState", ts,
        originalCwd: ws.originalCwd || "",
        worktreePath: ws.worktreePath || "",
        worktreeName: ws.worktreeName || "",
        worktreeBranch: ws.worktreeBranch || "",
      };
    } else {
      // ExitWorktree: worktreeSession is null — worktree was exited/removed
      return { kind: "WorktreeCleared", ts };
    }
  }

  // FileHistorySnapshot: type=file-history-snapshot
  if (parsed.type === "file-history-snapshot" && parsed.snapshot) {
    return {
      kind: "FileHistorySnapshot", ts,
      messageId: parsed.messageId || "",
      filePaths: Object.keys(parsed.snapshot?.trackedFileBackups || {}),
    };
  }

  // EffortLevel: settings object containing effortLevel (emitted on /effort changes)
  if (typeof parsed.effortLevel === "string" && parsed.permissions !== undefined) {
    return {
      kind: "EffortLevel", ts,
      level: parsed.effortLevel,
    };
  }

  // agent-name → reuse CustomTitle
  if (parsed.type === "agent-name" && parsed.agentName) {
    return {
      kind: "CustomTitle", ts,
      title: parsed.agentName,
      sessionId: parsed.sessionId || "",
    };
  }

  // ApiError: type=system, subtype=api_error (retry info, HTTP status)
  if (parsed.type === "system" && parsed.subtype === "api_error") {
    return {
      kind: "ApiError", ts,
      status: parsed.error?.status || 0,
      message: parsed.error?.message || parsed.error?.type || "",
      retryAttempt: parsed.retryAttempt ?? null,
      retryInMs: parsed.retryInMs ?? null,
    };
  }

  // TurnDuration: type=system, subtype=turn_duration
  if (parsed.type === "system" && parsed.subtype === "turn_duration") {
    return {
      kind: "TurnDuration", ts,
      durationMs: parsed.durationMs || 0,
      messageCount: parsed.messageCount || 0,
    };
  }

  // SubagentSpawn: standalone object with description + prompt (Agent tool input)
  if (typeof parsed.description === "string" && typeof parsed.prompt === "string" && !parsed.type) {
    // [IN-30] Preserve enough Agent prompt text for retained prompt/result inspector sections.
    return {
      kind: "SubagentSpawn", ts,
      description: parsed.description.slice(0, 200),
      prompt: parsed.prompt.slice(0, 2000),
      subagentType: typeof parsed.subagent_type === "string" ? parsed.subagent_type : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  }

  // ToolInput: standalone tool input objects (Bash, Read, Edit, etc.)
  // Match by presence of known tool input keys without being a conversation message
  if (!parsed.type) {
    if (typeof parsed.command === "string" && typeof parsed.description === "string" && !parsed.prompt) {
      return { kind: "ToolInput", ts, toolName: "Bash", input: parsed };
    }
    if (typeof parsed.file_path === "string" && parsed.old_string !== undefined) {
      return { kind: "ToolInput", ts, toolName: "Edit", input: parsed };
    }
    if (typeof parsed.file_path === "string" && typeof parsed.content === "string") {
      return { kind: "ToolInput", ts, toolName: "Write", input: parsed };
    }
    if (typeof parsed.file_path === "string" && !parsed.content && !parsed.old_string) {
      return { kind: "ToolInput", ts, toolName: "Read", input: parsed };
    }
    if (typeof parsed.pattern === "string" && parsed.path !== undefined) {
      return { kind: "ToolInput", ts, toolName: "Grep", input: parsed };
    }
    if (typeof parsed.pattern === "string" && !parsed.path) {
      return { kind: "ToolInput", ts, toolName: "Glob", input: parsed };
    }
    if (parsed.questions && Array.isArray(parsed.questions)) {
      return { kind: "ToolInput", ts, toolName: "AskUserQuestion", input: parsed };
    }
  }

  // ── Hook events (present only when Claude Code emits hook payloads) ──

  // Hook event data uses `hook_event_name` field (consistent with UserPromptSubmit/Status)
  if (typeof parsed.hook_event_name === "string") {
    const he = parsed.hook_event_name;
    const data = parsed.data ?? parsed;

    if (he === "SessionEnd") {
      return { kind: "SessionEndEvent", ts, reason: data.reason || "" };
    }
    if (he === "Stop" || he === "StopFailure") {
      return { kind: "StopEvent", ts, stopHookActive: !!data.stop_hook_active };
    }
    if (he === "PreCompact") {
      return { kind: "PreCompactEvent", ts, trigger: data.trigger || "" };
    }
    if (he === "PostCompact") {
      return { kind: "PostCompactEvent", ts, trigger: data.trigger || "", summary: data.compact_summary || "" };
    }
    if (he === "InstructionsLoaded") {
      return { kind: "InstructionsLoadedEvent", ts, filePath: data.file_path || "", memoryType: data.memory_type || "", loadReason: data.load_reason || "" };
    }
    if (he === "ConfigChange") {
      return { kind: "ConfigChangeEvent", ts, source: data.source || "", filePath: data.file_path || "" };
    }
    if (he === "CwdChanged") {
      return { kind: "CwdChangedEvent", ts, oldCwd: data.old_cwd || "", newCwd: data.new_cwd || "" };
    }
    if (he === "FileChanged") {
      return { kind: "FileChangedEvent", ts, filePath: data.file_path || "", event: data.event || "" };
    }
    if (he === "TaskCreated") {
      return { kind: "TaskCreatedEvent", ts, taskId: data.task_id || "", taskSubject: data.task_subject || "" };
    }
    if (he === "TaskCompleted") {
      return { kind: "TaskCompletedEvent", ts, taskId: data.task_id || "", taskSubject: data.task_subject || "" };
    }
    if (he === "Elicitation" || he === "ElicitationResult") {
      return { kind: "ElicitationEvent", ts, mcpServerName: data.mcp_server_name || "", message: data.message || "" };
    }
    if (he === "Notification") {
      return { kind: "NotificationHookEvent", ts, message: data.message || "", title: data.title || "" };
    }
    if (he === "SubagentStop") {
      return { kind: "SubagentStopEvent", ts, agentId: data.agent_id || "", agentType: data.agent_type || "" };
    }
    if (he === "Setup") {
      return { kind: "SetupEvent", ts, trigger: data.trigger || "" };
    }
    if (he === "PostToolUseFailure") {
      // Map to existing ToolResult with error
      return { kind: "ToolResult", ts, toolName: data.tool_name || "", durationMs: 0, toolResultSizeBytes: 0, error: data.error || "hook failure" };
    }
  }

  // Alternative: some hook events may arrive via the progress-style wrapper
  if (parsed.type === "progress" && parsed.data?.type === "hook_event") {
    const he = parsed.data.hook_event_name;
    if (he === "SessionEnd") {
      return { kind: "SessionEndEvent", ts, reason: parsed.data.reason || "" };
    }
    if (he === "CwdChanged") {
      return { kind: "CwdChangedEvent", ts, oldCwd: parsed.data.old_cwd || "", newCwd: parsed.data.new_cwd || "" };
    }
  }

  return null;
}

// ── Fetch classifier ──

function classifyFetch(ts: number, entry: TapEntry): TapEvent {
  const hdrs = (entry.hdrs as Record<string, string> | undefined) ?? {};
  return {
    kind: "ApiFetch", ts,
    url: String(entry.url || ""),
    method: String(entry.method || "GET"),
    status: typeof entry.status === "number" ? entry.status : null,
    bodyLen: typeof entry.bodyLen === "number" ? entry.bodyLen : 0,
    durationMs: typeof entry.dur === "number" ? entry.dur : 0,
    headers: hdrs,
    contentType: typeof entry.ct === "string" ? entry.ct : undefined,
    contentLength: typeof entry.cl === "number" ? entry.cl : undefined,
    responseSnap: typeof entry.resp === "string" ? entry.resp : null,
    op: typeof entry.op === "string" ? entry.op : undefined,
  };
}

// ── Spawn classifier ──

function classifySpawn(ts: number, entry: TapEntry): TapEvent {
  return {
    kind: "SubprocessSpawn", ts,
    cmd: String(entry.cmd || ""),
    cwd: typeof entry.cwd === "string" ? entry.cwd : null,
    pid: typeof entry.pid === "number" ? entry.pid : null,
  };
}

// [SI-25] Status line data capture: classifies status-line category entries into StatusLineUpdate
function classifyStatusLine(ts: number, entry: TapEntry): TapEvent {
  return {
    kind: "StatusLineUpdate", ts,
    sessionId: String(entry.sessionId || ""),
    cwd: String(entry.cwd || ""),
    modelId: String(entry.modelId || ""),
    modelDisplayName: String(entry.modelDisplayName || ""),
    cliVersion: String(entry.cliVersion || ""),
    outputStyle: String(entry.outputStyle || ""),
    totalCostUsd: typeof entry.totalCostUsd === "number" ? entry.totalCostUsd : 0,
    totalDurationMs: typeof entry.totalDurationMs === "number" ? entry.totalDurationMs : 0,
    totalApiDurationMs: typeof entry.totalApiDurationMs === "number" ? entry.totalApiDurationMs : 0,
    totalLinesAdded: typeof entry.totalLinesAdded === "number" ? entry.totalLinesAdded : 0,
    totalLinesRemoved: typeof entry.totalLinesRemoved === "number" ? entry.totalLinesRemoved : 0,
    totalInputTokens: typeof entry.totalInputTokens === "number" ? entry.totalInputTokens : 0,
    totalOutputTokens: typeof entry.totalOutputTokens === "number" ? entry.totalOutputTokens : 0,
    contextWindowSize: typeof entry.contextWindowSize === "number" ? entry.contextWindowSize : 0,
    currentInputTokens: typeof entry.currentInputTokens === "number" ? entry.currentInputTokens : 0,
    currentOutputTokens: typeof entry.currentOutputTokens === "number" ? entry.currentOutputTokens : 0,
    cacheCreationInputTokens: typeof entry.cacheCreationInputTokens === "number" ? entry.cacheCreationInputTokens : 0,
    cacheReadInputTokens: typeof entry.cacheReadInputTokens === "number" ? entry.cacheReadInputTokens : 0,
    contextUsedPercent: typeof entry.contextUsedPercent === "number" ? entry.contextUsedPercent : 0,
    contextRemainingPercent: typeof entry.contextRemainingPercent === "number" ? entry.contextRemainingPercent : 0,
    exceeds200kTokens: !!entry.exceeds200kTokens,
    fiveHourUsedPercent: typeof entry.fiveHourUsedPercent === "number" ? entry.fiveHourUsedPercent : 0,
    fiveHourResetsAt: typeof entry.fiveHourResetsAt === "number" ? entry.fiveHourResetsAt : 0,
    sevenDayUsedPercent: typeof entry.sevenDayUsedPercent === "number" ? entry.sevenDayUsedPercent : 0,
    sevenDayResetsAt: typeof entry.sevenDayResetsAt === "number" ? entry.sevenDayResetsAt : 0,
    vimMode: String(entry.vimMode || ""),
  };
}

// [IN-10] Tap event pipeline: classifies raw TapEntry values into typed TapEvent objects
/**
 * Classify a raw TapEntry into a typed TapEvent.
 * Returns null for noise, deltas, and unrecognized entries.
 * Pure function, no state.
 */
export function classifyTapEntry(entry: TapEntry): TapEvent | null {
  const result = classifyTapEntryInner(entry);
  if (result) result.cat = entry.cat;
  return result;
}

function classifyTapEntryInner(entry: TapEntry): TapEvent | null {
  try {
    const { ts, cat } = entry;

    // Parse (SSE): parse snap JSON, match on type field
    if (cat === "parse" && typeof entry.snap === "string") {
      try {
        const parsed = JSON.parse(entry.snap);
        return classifyParse(ts, parsed);
      } catch {
        return null;
      }
    }

    // Stringify (outgoing): parse snap JSON, match on shape
    if (cat === "stringify" && typeof entry.snap === "string") {
      try {
        const parsed = JSON.parse(entry.snap);
        return classifyStringify(ts, parsed);
      } catch {
        return null;
      }
    }

    // Fetch: direct mapping
    if (cat === "fetch") {
      return classifyFetch(ts, entry);
    }

    // [IN-18] Ping: dedicated HTTP ping to Anthropic origin
    if (cat === "ping") {
      return {
        kind: "HttpPing", ts,
        durationMs: typeof entry.dur === "number" ? entry.dur : 0,
        status: typeof entry.status === "number" ? entry.status : null,
      };
    }

    // Spawn: direct mapping (both child_process and Bun.spawn)
    if (cat === "spawn") {
      return classifySpawn(ts, entry);
    }

    // Status line: full status payload from CLI statusLine command
    if (cat === "status-line") {
      return classifyStatusLine(ts, entry);
    }

    // [IN-19] System prompt capture: classifies system-prompt category into SystemPromptCapture
    if (cat === "system-prompt" && typeof entry.text === "string") {
      const blocks = Array.isArray(entry.blocks)
        ? (entry.blocks as Array<{ text: string; cc?: { type: string } }>).map((b) => {
            const block: SystemPromptBlock = { text: b.text };
            if (b.cc) block.cacheControl = b.cc;
            return block;
          })
        : undefined;
      const messages = Array.isArray(entry.messages)
        ? (entry.messages as CapturedMessage[])
        : undefined;
      return {
        kind: "SystemPromptCapture", ts,
        text: entry.text as string,
        model: String(entry.model || ""),
        messageCount: typeof entry.msgCount === "number" ? (entry.msgCount as number) : 0,
        blocks,
        messages,
      };
    }

    // ── New TAP categories (MISSED-HOOKS) ──

    if (cat === "fspromises") {
      return {
        kind: "AsyncFileOp", ts,
        op: String(entry.op || ""),
        path: String(entry.path || ""),
        size: typeof entry.size === "number" ? entry.size : 0,
        durationMs: typeof entry.dur === "number" ? entry.dur : 0,
        error: entry.err ? String(entry.err) : null,
      };
    }

    if (cat === "bunfile") {
      return {
        kind: "BunFileOp", ts,
        op: String(entry.op || ""),
        path: String(entry.path || ""),
        durationMs: typeof entry.dur === "number" ? entry.dur : 0,
      };
    }

    if (cat === "abort") {
      return {
        kind: "AbortSignal", ts,
        reason: String(entry.reason || ""),
      };
    }

    if (cat === "fswatch") {
      return {
        kind: "FileWatch", ts,
        op: String(entry.op || ""),
        path: String(entry.path || ""),
      };
    }

    if (cat === "textdecoder") {
      return {
        kind: "TextDecoderChunk", ts,
        length: typeof entry.len === "number" ? entry.len : 0,
        snap: typeof entry.snap === "string" ? entry.snap : "",
      };
    }

    if (cat === "events") {
      return {
        kind: "EmitterEvent", ts,
        eventType: String(entry.type || ""),
        source: String(entry.src || ""),
      };
    }

    if (cat === "envproxy") {
      return {
        kind: "EnvAccess", ts,
        key: String(entry.key || ""),
        hasValue: !!entry.hasValue,
      };
    }

    if (cat === "console") {
      return {
        kind: "ConsoleOutput", ts,
        op: String(entry.op || ""),
        msg: String(entry.msg || ""),
      };
    }

    if (cat === "fs") {
      return {
        kind: "SyncFileOp", ts,
        op: String(entry.op || ""),
        path: String(entry.path || ""),
        size: typeof entry.size === "number" ? entry.size : 0,
        content: typeof entry.content === "string" ? entry.content : null,
        result: typeof entry.result === "boolean" ? entry.result : null,
      };
    }

    if (cat === "timer") {
      return {
        kind: "TimerOp", ts,
        op: String(entry.op || ""),
        id: typeof entry.id === "number" ? entry.id : 0,
        delay: typeof entry.delay === "number" ? entry.delay : 0,
        caller: String(entry.caller || ""),
      };
    }

    if (cat === "bun") {
      return {
        kind: "BunOp", ts,
        op: String(entry.op || ""),
        path: String(entry.path || ""),
        cmd: String(entry.cmd || ""),
        cwd: typeof entry.cwd === "string" ? entry.cwd : null,
        pid: typeof entry.pid === "number" ? entry.pid : null,
        code: typeof entry.code === "number" ? entry.code : null,
        size: typeof entry.size === "number" ? entry.size : 0,
        durationMs: typeof entry.dur === "number" ? entry.dur : 0,
      };
    }

    if (cat === "websocket") {
      return {
        kind: "WebSocketOp", ts,
        op: String(entry.op || ""),
        url: String(entry.url || ""),
        code: typeof entry.code === "number" ? entry.code : null,
        reason: String(entry.reason || ""),
        length: typeof entry.len === "number" ? entry.len : 0,
      };
    }

    if (cat === "stream") {
      return {
        kind: "StreamOp", ts,
        op: String(entry.op || ""),
        src: String(entry.src || ""),
        dest: String(entry.dest || ""),
      };
    }

    // Remaining categories (stdout, stderr, require) -> null (disk only)
    return null;
  } catch {
    return null;
  }
}
