import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { useActivityStore } from "../store/activity";
import { tapEventBus } from "../lib/tapEventBus";
import { reduceTapEvent } from "../lib/tapStateReducer";
import { TapMetadataAccumulator } from "../lib/tapMetadataAccumulator";
import { TapSubagentTracker } from "../lib/tapSubagentTracker";
import { normalizePath, canonicalizePath } from "../lib/paths";
import { getResumeId, resolveModelFamily } from "../lib/claude";
import { buildSubagentTabs } from "../lib/contextProjection";
import { useSettingsStore } from "../store/settings";
import { dlog } from "../lib/debugLog";
import { getNoisyEventKinds } from "../lib/noisyEventKinds";
import { traceSync } from "../lib/perfTrace";
import { settledStateManager } from "../lib/settledState";
import type { TapEvent } from "../types/tapEvents";
import type { SessionState, PermissionMode } from "../types/session";
import type { ToolInputDiffData } from "../types/activity";
import { getTapCategoryLabel, getTapCategoryMeta } from "../lib/tapCatalog";

/** Return discriminating fields for key event types (for debug logs). */
function eventDetail(event: TapEvent): string {
  switch (event.kind) {
    case "ConversationMessage":
      return ` type=${event.messageType} sidechain=${event.isSidechain} stop=${event.stopReason} agent=${event.agentId}`;
    case "TurnEnd":
      return ` stop=${event.stopReason}`;
    case "ToolCallStart":
      return ` tool=${event.toolName}`;
    case "PermissionPromptShown":
    case "PermissionApproved":
      return ` tool=${event.toolName}`;
    case "SubagentSpawn":
      return ` desc="${event.description.slice(0, 50)}"`;
    case "SubagentNotification":
      return ` status=${event.status}`;
    case "SubagentLifecycle":
      return ` variant=${event.variant} type=${event.agentType}`;
    case "UserInput":
      return ` "${event.display.slice(0, 30)}"`;
    case "SlashCommand":
      return ` ${event.command}`;
    default:
      return "";
  }
}

// [SI-13] Event priority: runs reduceTapEvent which enforces sticky actionNeeded guard
// [SI-20] Worktree cwd detection: ConversationMessage/SessionRegistration/WorktreeState -> updateConfig
// [SI-23] Plan detection: ToolCallStart(ExitPlanMode) handled by reducer, processor dispatches
/**
 * React hook bridging tapEventBus to the Zustand store.
 * Subscribes to tap events for a session, runs reducers, updates store.
 * Sole source of state/metadata/subagent data (replaces useInspectorState's processing).
 */
export function useTapEventProcessor(
  sessionId: string | null
): { claudeSessionId: string | null; userPrompt: string | null } {
  const updateState = useSessionStore((s) => s.updateState);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const addSubagent = useSessionStore((s) => s.addSubagent);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const removeSubagent = useSessionStore((s) => s.removeSubagent);
  const addSkillInvocation = useSessionStore((s) => s.addSkillInvocation);
  const addCommandHistory = useSessionStore((s) => s.addCommandHistory);
  const updateProcessHealth = useSessionStore((s) => s.updateProcessHealth);

  // useState for values that TerminalPanel reacts to
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [userPrompt, setUserPrompt] = useState<string | null>(null);

  const stateRef = useRef<SessionState>("starting");
  const metaAccRef = useRef<TapMetadataAccumulator | null>(null);
  const subTrackerRef = useRef<TapSubagentTracker | null>(null);
  const healthCountRef = useRef(0);
  const lastHighMemWarnRef = useRef(0);
  const apiIpResolvedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (!sessionId) return;

    // Create per-session instances
    const metaAcc = new TapMetadataAccumulator();
    const subTracker = new TapSubagentTracker(sessionId);
    metaAccRef.current = metaAcc;
    subTrackerRef.current = subTracker;
    stateRef.current = "starting";
    let activityTurnCounter = 0;
    setClaudeSessionId(null);
    setUserPrompt(null);

    const updateCwdIfChanged = (cwd: string) => {
      const normalized = normalizePath(cwd);
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
      if (session && normalized !== session.config.workingDir) {
        updateConfig(sessionId, { workingDir: normalized });
      }
    };

    const handleEvent = (event: TapEvent) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      traceSync("tap.handle_event", () => {

      useSessionStore.getState().addSeenEventKind(event.kind);

      if (!getNoisyEventKinds().has(event.kind)) {
        const cat = event.cat || "?";
        const categoryLabel = getTapCategoryLabel(cat);
        dlog("tap", sid, `[${categoryLabel}] ${event.kind}${eventDetail(event)}`, "DEBUG", {
          event: "tap.classified_event",
          data: {
            category: categoryLabel,
            hookSource: getTapCategoryMeta(cat).hookSource,
            kind: event.kind,
          },
        });
      }

      // No UUID dedup — CLI re-serializes conversation messages for JSONL persistence
      // and hook dispatch (2-3 stringify calls per message), but the state reducer is
      // idempotent and metadata accumulator overwrites. The only effect of duplicates
      // is 2-3x subagent messages in the inspector, capped at 200 per agent.
      // Previous UUID dedup caused actionNeeded to get stuck: the set's 500-entry
      // eviction could forget UUIDs, letting stale re-serialized messages race with
      // state transitions and swallow the ConversationMessage(user) that clears it.

      // 1. State reducer
      const prevState = stateRef.current;
      const newState = reduceTapEvent(prevState, event);
      if (newState !== prevState) {
        dlog("inspector", sid, `state ${prevState} → ${newState} (${event.kind})`);
        stateRef.current = newState;
        updateState(sid, newState);
      } else if (!getNoisyEventKinds().has(event.kind)) {
        dlog("inspector", sid, `state ${prevState} unchanged by ${event.kind}`, "DEBUG");
      }

      // Read originalCwd BEFORE accumulator clears worktreeInfo
      let worktreeExitCwd: string | null = null;
      if (event.kind === "WorktreeCleared") {
        const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
        worktreeExitCwd = session?.metadata?.worktreeInfo?.originalCwd || null;
      }

      const suppressSubagentWorktreeEvent =
        (event.kind === "WorktreeState" || event.kind === "WorktreeCleared")
        && subTracker.isSubagentInFlight();

      // 2. Metadata accumulator
      const metaDiff = suppressSubagentWorktreeEvent ? null : metaAcc.process(event);
      if (suppressSubagentWorktreeEvent) {
        dlog("tap", sid, `${event.kind} suppressed — subagent in flight`, "DEBUG");
      }
      if (metaDiff) {
        updateMetadata(sid, metaDiff);
      }

      // 2a. [TA-02] Track unique tool names seen across all sessions
      if (event.kind === "ToolCallStart") {
        useSessionStore.getState().addSeenToolName(event.toolName);
      }

      // 2b. Model registry — capture observed model IDs + context window sizes
      if (event.kind === "StatusLineUpdate" && event.modelId && event.contextWindowSize > 0) {
        const family = resolveModelFamily(event.modelId);
        if (family) {
          useSettingsStore.getState().updateModelRegistry({
            modelId: event.modelId,
            family: family.keyword,
            contextWindowSize: event.contextWindowSize,
            lastSeenAt: Date.now(),
          });
        }
      }

      // 3. Subagent tracker
      const subActions = subTracker.process(event);
      for (const action of subActions) {
        if (action.type === "add" && action.subagent) {
          dlog("inspector", sid, `subagent discovered id=${action.subagent.id} desc="${action.subagent.description}"`, "DEBUG");
          addSubagent(sid, action.subagent);
        } else if (action.type === "update" && action.subagentId && action.updates) {
          updateSubagent(sid, action.subagentId, action.updates);
        }
      }

      // 4. Skill invocations
      if (event.kind === "SkillInvocation") {
        dlog("tap", sid, `skill invoked: ${event.skill} (success=${event.success})`, "DEBUG");
        addSkillInvocation(sid, {
          id: `skill-${event.ts}-${event.skill}`,
          skill: event.skill,
          success: event.success,
          allowedTools: event.allowedTools,
          timestamp: event.ts,
        });
      }

      // 5. Activity tracking — file change events for the Activity Panel
      {
        const activityStore = useActivityStore.getState();
        const isSidechain = subTracker.isSidechainActive?.() ?? false;
        const agentId = isSidechain ? (subTracker.getLastActiveAgentId?.() ?? null) : null;

        if (event.kind === "TurnStart" && !isSidechain) {
          activityTurnCounter++;
          activityStore.startTurn(sid, `turn-${activityTurnCounter}`);
        }

        // endTurn is driven by settled-state (see subscription below), not TurnEnd,
        // so it only fires when all work is genuinely done (including subagents).

        if (event.kind === "ToolInput") {
          // Suppress phantom Read events during subagent context re-serialization.
          // When a subagent is in flight but sidechainActive is false and the last
          // main-agent tool was Agent, ToolInput(Read) events are re-serialized
          // conversation context, not genuine tool executions.
          const isPhantomRead = event.toolName === "Read"
            && subTracker.isSubagentInFlight()
            && !isSidechain
            && subTracker.getLastMainToolCall?.() === "Agent";
          if (isPhantomRead) {
            dlog("tap", sid, `phantom Read suppressed: ${event.input.file_path}`, "DEBUG");
          }

          const rawFilePath = event.input.file_path ?? event.input.notebook_path;
          if (typeof rawFilePath === "string" && !isPhantomRead) {
            const filePath = canonicalizePath(rawFilePath);
            const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
            const workDir = session?.config.workingDir ?? "";
            const isExternal = workDir ? !normalizePath(filePath).startsWith(workDir) : false;

            if (event.toolName === "Read") {
              activityStore.addFileActivity(sid, filePath, "read", {
                agentId,
                toolName: "Read",
                isExternal,
              });
            } else if (event.toolName === "Write") {
              const activity = activityStore.sessions[sid];
              const isNew = !activity?.visitedPaths.has(filePath);
              const toolInputData: ToolInputDiffData = {
                type: "write",
                content: String(event.input.content ?? ""),
              };
              activityStore.addFileActivity(sid, filePath, isNew ? "created" : "modified", {
                agentId,
                toolName: "Write",
                isExternal,
                toolInputData,
              });
            } else if (event.toolName === "Edit") {
              const toolInputData: ToolInputDiffData = {
                type: "edit",
                oldString: String(event.input.old_string ?? ""),
                newString: String(event.input.new_string ?? ""),
              };
              activityStore.addFileActivity(sid, filePath, "modified", {
                agentId,
                toolName: "Edit",
                isExternal,
                toolInputData,
              });
            } else if (event.toolName === "NotebookEdit") {
              activityStore.addFileActivity(sid, filePath, "modified", {
                agentId,
                toolName: "NotebookEdit",
                isExternal,
              });
            }
          }

          // Grep — track searched file or folder
          if (event.toolName === "Grep") {
            const rawGrepPath = typeof event.input.path === "string" ? event.input.path : null;
            if (rawGrepPath) {
              const grepPath = canonicalizePath(rawGrepPath);
              const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
              const workDir = session?.config.workingDir ?? "";
              const isExternal = workDir ? !normalizePath(grepPath).startsWith(workDir) : false;
              const lastSegment = grepPath.split("/").pop() ?? "";
              const looksLikeFile = lastSegment.includes(".") && !lastSegment.startsWith(".");
              activityStore.addFileActivity(sid, grepPath, "searched", {
                agentId,
                toolName: "Grep",
                isExternal,
                isFolder: !looksLikeFile,
              });
            } else {
              // No path = searching project root
              const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
              const workDir = session?.config.workingDir ?? "";
              if (workDir) {
                activityStore.addFileActivity(sid, canonicalizePath(workDir), "searched", {
                  agentId,
                  toolName: "Grep",
                  isFolder: true,
                });
              }
            }
          }

          // Glob — always targets a folder
          if (event.toolName === "Glob") {
            const rawGlobPath = typeof event.input.path === "string" ? event.input.path : null;
            const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
            const workDir = session?.config.workingDir ?? "";
            const targetPath = rawGlobPath ? canonicalizePath(rawGlobPath) : (workDir ? canonicalizePath(workDir) : null);
            if (targetPath) {
              const isExternal = workDir ? !normalizePath(targetPath).startsWith(workDir) : false;
              activityStore.addFileActivity(sid, targetPath, "searched", {
                agentId,
                toolName: "Glob",
                isExternal,
                isFolder: true,
              });
            }
          }

          // LSP — always targets a file (uses camelCase filePath, not snake_case file_path)
          if (event.toolName === "LSP") {
            const rawLspPath = typeof event.input.filePath === "string" ? event.input.filePath : null;
            if (rawLspPath) {
              const lspPath = canonicalizePath(rawLspPath);
              const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
              const workDir = session?.config.workingDir ?? "";
              const isExternal = workDir ? !normalizePath(lspPath).startsWith(workDir) : false;
              activityStore.addFileActivity(sid, lspPath, "searched", {
                agentId,
                toolName: "LSP",
                isExternal,
              });
            }
          }

          // Bash file tracking is unimplemented — the syscall tracer that
          // previously observed file ops by Claude's descendants has been
          // removed, and the old bashFileParser heuristic is not coming back.
        }

        if (event.kind === "PermissionRejected") {
          const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
          const lastAction = session?.metadata.currentAction ?? "";
          const pathMatch = lastAction.match(/:\s*(.+)/);
          if (pathMatch) {
            activityStore.markPermissionDenied(sid, canonicalizePath(pathMatch[1].trim()));
          }
        }

        if (event.kind === "InstructionsLoadedEvent") {
          const ctxPath = canonicalizePath(event.filePath);
          activityStore.addContextFile(sid, {
            path: ctxPath,
            memoryType: event.memoryType,
            loadReason: event.loadReason,
          });
          // Also record as a read so context files appear in Response mode and the file tree
          activityStore.addFileActivity(sid, ctxPath, "read", {
            agentId,
            toolName: "context",
          });
        }
      }

      // 6. Session-level signals
      // [SS-01] [SS-02] Detect session switches via sid field change (plan-mode fork, /resume, compaction)
      // Gate behind isSubagentInFlight: subagent session init records arrive through TAP
      // before the first sidechain ConversationMessage, so sidechainActive alone is insufficient.
      if (event.kind === "SessionRegistration") {
        if (!subTracker.isSubagentInFlight()) {
          setClaudeSessionId(event.sessionId);
        } else {
          dlog("tap", sid, `SessionRegistration(${event.sessionId}) suppressed — subagent in flight`, "DEBUG");
        }
      }

      // [SL-18] CustomTitle always persists to session store + settings sessionNames map
      if (event.kind === "CustomTitle") {
        const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
        if (session && event.title !== session.name) {
          useSessionStore.getState().renameSession(sid, event.title);
          useSettingsStore.getState().setSessionName(getResumeId(session), event.title);
        }
      }

      // [AS-01] markUserMessage on UserInput/SlashCommand (not TurnStart) — response window starts at real user input
      if (event.kind === "UserInput" || event.kind === "SlashCommand") {
        useActivityStore.getState().markUserMessage(sid);
        setUserPrompt(event.display.slice(0, 200));
      }

      if (event.kind === "SlashCommand") {
        addCommandHistory(sid, event.command, event.ts);
        useSettingsStore.getState().recordCommandUsage(event.command);
      }

      // SystemPromptCapture → collect all unique observed prompts
      if (event.kind === "SystemPromptCapture") {
        useSettingsStore.getState().addObservedPrompt(event.text, event.model);

        // Bridge resultText from capturedMessages to TAP-derived subagents.
        // capturedMessages pair Agent tool_use with tool_result blocks authoritatively,
        // but TAP subagents never get resultText because SubagentNotification doesn't fire.
        if (event.messages) {
          const tabs = buildSubagentTabs(event.messages);
          const subagents = useSessionStore.getState().subagents.get(sid) || [];
          for (const tab of tabs) {
            if (!tab.resultText) continue;
            const labelPrefix = tab.label.endsWith("\u2026") ? tab.label.slice(0, -1) : tab.label;
            if (labelPrefix.length < 3) continue;
            // Match by description prefix + prompt text to avoid ambiguous collisions
            const candidates = subagents.filter(sub => sub.description.startsWith(labelPrefix));
            const matched = candidates.length === 1
              ? candidates[0]
              : candidates.find(sub => sub.promptText && sub.promptText === tab.promptText) ?? null;
            if (matched && !matched.resultText) {
              updateSubagent(sid, matched.id, { resultText: tab.resultText, completed: true });
            }
          }

          // Prune phantom subagents that don't correspond to any Agent tool_use
          // in capturedMessages (e.g. CLI-internal aside_question sidechains).
          // Match by exact promptText (precise) with description prefix fallback.
          // Guard: never prune agents that already have resultText — they were
          // previously validated against capturedMessages and may have been
          // compacted away since.
          if (tabs.length > 0 && subagents.length > tabs.length) {
            const tabPrompts = new Set(tabs.map(t => t.promptText).filter(Boolean));
            for (const sub of subagents) {
              // Exact prompt match (precise)
              if (sub.promptText && tabPrompts.has(sub.promptText)) continue;
              // Description prefix fallback (for agents without promptText)
              const matchesByDesc = tabs.some(tab => {
                const prefix = tab.label.endsWith("\u2026") ? tab.label.slice(0, -1) : tab.label;
                return prefix.length >= 3 && sub.description.startsWith(prefix);
              });
              if (matchesByDesc) continue;
              // Only prune completed phantoms without resultText.
              // Agents with resultText were previously validated and are safe
              // from compaction-induced false positives.
              if (sub.completed && !sub.resultText) {
                dlog("inspector", sid, `pruning phantom subagent ${sub.id} desc="${sub.description}"`, "DEBUG");
                removeSubagent(sid, sub.id);
              }
            }
          }
        }
      }

      // ProcessHealth → store (throttled to ~every 5s)
      if (event.kind === "ProcessHealth") {
        healthCountRef.current++;
        if (healthCountRef.current % 5 === 0) {
          updateProcessHealth(sid, { rss: event.rss, heapUsed: event.heapUsed, uptime: event.uptime });
        }
        if (event.rss > 1_000_000_000) {
          const now = Date.now();
          if (now - lastHighMemWarnRef.current >= 600_000) {
            lastHighMemWarnRef.current = now;
            dlog("inspector", sid, `High memory: ${Math.round(event.rss / 1_000_000)}MB RSS`, "WARN");
          }
        }
      }

      // EffortLevel → persist to config for resume
      if (event.kind === "EffortLevel") {
        updateConfig(sid, { effort: event.level });
      }

      // ModeChange → reactive permission icon
      if (event.kind === "ModeChange") {
        const modeMap: Record<string, PermissionMode> = {
          "default": "default",
          "acceptEdits": "acceptEdits",
          "plan": "planMode",
          "bypassPermissions": "bypassPermissions",
        };
        const mapped = modeMap[event.to];
        if (mapped) {
          updateConfig(sid, { permissionMode: mapped });
        }
      }

      // [SI-20] Worktree cwd detection: SessionRegistration gated behind isSubagentInFlight
      if (event.kind === "ConversationMessage" && event.cwd && !event.isSidechain) {
        if (!subTracker.isSubagentInFlight()) {
          updateCwdIfChanged(event.cwd);
        } else {
          dlog("tap", sid, `ConversationMessage cwd(${event.cwd}) suppressed — subagent in flight`, "DEBUG");
        }
      }
      if (event.kind === "SessionRegistration" && event.cwd) {
        if (!subTracker.isSubagentInFlight()) {
          updateCwdIfChanged(event.cwd);
        } else {
          dlog("tap", sid, `SessionRegistration cwd(${event.cwd}) suppressed — subagent in flight`, "DEBUG");
        }
      }
      // WorktreeState: authoritative worktree path from CLI
      if (event.kind === "WorktreeState" && event.worktreePath) {
        if (!suppressSubagentWorktreeEvent) {
          updateCwdIfChanged(event.worktreePath);
        }
      }
      // WorktreeCleared: restore original working directory
      if (event.kind === "WorktreeCleared" && worktreeExitCwd) {
        if (!suppressSubagentWorktreeEvent) {
          updateCwdIfChanged(worktreeExitCwd);
        }
      }

      // Resolve API IP on first fetch (skip if already resolved by any session)
      if (event.kind === "ApiFetch" && !apiIpResolvedRef.current && !useSettingsStore.getState().apiIp) {
        apiIpResolvedRef.current = true;
        invoke("resolve_api_host")
          .then((ip) => useSettingsStore.getState().setApiIp(ip as string))
          .catch((err: unknown) => dlog("session", sid, `API IP resolve failed: ${err}`, "WARN"));
      }
      }, {
        module: "tap",
        sessionId: sid,
        event: "tap.handle_event",
        warnAboveMs: 12,
        data: {
          kind: event.kind,
          category: event.cat ?? null,
        },
      });
    };

    const unsub = tapEventBus.subscribe(sessionId, handleEvent);

    // [AS-03] End activity turns on settled-idle — still needed for
    // the UI's Response mode boundary and stats recomputation.
    const unsubSettled = settledStateManager.subscribe(
      (settledSid, kind) => {
        if (settledSid === sessionId && kind === "idle") {
          useActivityStore.getState().endTurn(sessionId);
        }
      },
      () => {},
    );

    return () => {
      unsub();
      unsubSettled();
      metaAcc.reset();
      subTracker.reset();
      metaAccRef.current = null;
      subTrackerRef.current = null;
    };
  }, [sessionId, updateState, updateMetadata, updateConfig, addSubagent, updateSubagent, removeSubagent, addSkillInvocation, addCommandHistory, updateProcessHealth]);

  return { claudeSessionId, userPrompt };
}
