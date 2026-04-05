import type { TapEvent } from "../types/tapEvents";
import type { Subagent, SubagentMessage, SessionState } from "../types/session";
import { isSubagentActive } from "../types/session";
import { getNoisyEventKinds } from "./noisyEventKinds";
import { dlog } from "./debugLog";

export interface SubagentAction {
  type: "add" | "update";
  subagentId?: string;
  subagent?: Subagent;
  updates?: Partial<Subagent>;
}

// [SI-09] Subagent data captured via inspector tap events (no JSONL watcher)
// [IN-03] Subagent tracking: Agent tool_use -> queue spawn -> first sidechain msg creates entry; pendingSpawns drained on UserInterruption/UserInput/SlashCommand
// [IN-06] Dead subagent purge removed -- idle subs remain visible until session ends
/**
 * Tracks subagent lifecycles from tap events.
 * One instance per session. Emits SubagentActions for the store.
 *
 * Replaces the agentId routing in INSTALL_HOOK (lines 90-162) and
 * subagent processing in useInspectorState (lines 218-248).
 */
type PendingSpawn = { description: string; prompt?: string; subagentType?: string; model?: string };

export class TapSubagentTracker {
  private parentSessionId: string;
  private pendingSpawns: PendingSpawn[] = [];
  private knownIds = new Set<string>();
  private subagentTokens = new Map<string, number>(); // agentId → accumulated tokens
  private subagentCost = new Map<string, number>();   // agentId → accumulated costUsd
  private subagentMsgs = new Map<string, SubagentMessage[]>(); // agentId → messages
  private agentStates = new Map<string, SessionState>();
  private lastEventTs = new Map<string, number>();   // agentId → timestamp of last routed event
  private lastActiveAgent: string | null = null;
  private sidechainActive = false;
  private seenSpawnFingerprints = new Set<string>(); // dedup re-serialized SubagentSpawn events
  private consumedSpawnFingerprints = new Set<string>(); // block stale re-serializations after UserInput clears seenSpawnFingerprints
  private processedUuids = new Set<string>(); // dedup re-serialized ConversationMessage content

  constructor(parentSessionId: string) {
    this.parentSessionId = parentSessionId;
  }

  /** Check if any tracked subagents are actively working. */
  hasActiveAgents(): boolean {
    for (const state of this.agentStates.values()) {
      if (isSubagentActive(state)) return true;
    }
    return false;
  }

  /** True when any subagent lifecycle is in progress — from spawn through completion.
   *  Covers the gap between SubagentSpawn and the first sidechain ConversationMessage
   *  (where pendingSpawns > 0 but hasActiveAgents() is false and sidechainActive is false). */
  isSubagentInFlight(): boolean {
    return this.pendingSpawns.length > 0 || this.sidechainActive || this.hasActiveAgents();
  }

  /** Whether a sidechain (subagent) conversation is currently active. */
  isSidechainActive(): boolean {
    return this.sidechainActive;
  }

  /** The agent ID of the most recently active subagent, or null. */
  getLastActiveAgentId(): string | null {
    return this.lastActiveAgent;
  }

  /** Mark all active subagents with the given state, returning update actions. */
  private markAllActive(targetState: SessionState): SubagentAction[] {
    const actions: SubagentAction[] = [];
    for (const agentId of this.knownIds) {
      const currentState = this.agentStates.get(agentId);
      if (currentState && isSubagentActive(currentState)) {
        dlog("inspector", this.parentSessionId, `subagent ${agentId} ${currentState} → ${targetState}`, "DEBUG");
        this.agentStates.set(agentId, targetState);
        actions.push({ type: "update", subagentId: agentId, updates: {
          state: targetState,
          currentToolName: null,
          currentEventKind: null,
          currentAction: null,
        } });
      }
    }
    return actions;
  }

  /** Process an event. Returns actions to apply to the store, or empty array. */
  process(event: TapEvent): SubagentAction[] {
    const actions: SubagentAction[] = [];

    switch (event.kind) {
      case "SubagentSpawn": {
        // Agent tool input with description + prompt → queue spawn data.
        // CLI re-serializes 2-3x per event; dedup by content fingerprint.
        const fingerprint = event.description + "|" + (event.prompt || "").slice(0, 200);
        // Block stale re-serializations of already-consumed spawns.
        // consumedSpawnFingerprints persists across UserInput/SlashCommand clears,
        // so late re-serializations that arrive after seenSpawnFingerprints was cleared
        // are still blocked.
        if (this.consumedSpawnFingerprints.has(fingerprint)) {
          dlog("inspector", this.parentSessionId, `subagent spawn blocked (already consumed) desc="${event.description.slice(0, 60)}"`, "DEBUG");
          break;
        }
        if (this.seenSpawnFingerprints.has(fingerprint)) {
          dlog("inspector", this.parentSessionId, `subagent spawn dedup skip desc="${event.description.slice(0, 60)}"`, "DEBUG");
          break;
        }
        this.seenSpawnFingerprints.add(fingerprint);
        this.pendingSpawns.push({
          description: event.description,
          prompt: event.prompt,
          subagentType: event.subagentType,
          model: event.model,
        });
        dlog("inspector", this.parentSessionId, `subagent spawn queued desc="${event.description.slice(0, 60)}"`, "DEBUG");
        break;
      }

      case "ConversationMessage": {
        // Track sidechain state for routing non-ConversationMessage events
        this.sidechainActive = event.isSidechain;
        // [IN-04] Subagent messages: isSidechain + agentId routing, late msg gating
        if (!event.isSidechain || !event.agentId) break;

        const agentId = event.agentId;

        // Don't re-activate agents already marked idle/dead by SubagentNotification,
        // SubagentLifecycle, or UserInterruption. Late sidechain messages arriving after
        // completion should not flip hasActiveAgents() back to true.
        if (this.knownIds.has(agentId) && !isSubagentActive(this.agentStates.get(agentId) ?? "dead")) {
          dlog("inspector", this.parentSessionId, `subagent ${agentId} late msg dropped (state=${this.agentStates.get(agentId)})`, "DEBUG");
          break;
        }

        // First message from a new subagent → create it
        if (!this.knownIds.has(agentId)) {
          // [IN-03] Skip CLI-internal sidechains (aside_question replays parent context,
          // creating a phantom entry that duplicates a real agent)
          if (agentId.startsWith("aside_question")) {
            dlog("inspector", this.parentSessionId, `skipping CLI-internal sidechain agentId=${agentId}`, "DEBUG");
            break;
          }
          this.knownIds.add(agentId);
          this.agentStates.set(agentId, "starting");
          const spawn = this.pendingSpawns.shift();
          const desc = spawn?.description || "Agent";
          if (spawn) {
            const fp = spawn.description + "|" + (spawn.prompt || "").slice(0, 200);
            this.consumedSpawnFingerprints.add(fp);
          }
          this.subagentTokens.set(agentId, 0);
          this.subagentMsgs.set(agentId, []);

          actions.push({
            type: "add",
            subagent: {
              id: agentId,
              parentSessionId: this.parentSessionId,
              state: "starting" as SessionState,
              description: desc,
              subagentType: spawn?.subagentType,
              model: spawn?.model,
              promptText: spawn?.prompt,
              tokenCount: 0,
              currentAction: null,
              currentToolName: null,
              currentEventKind: null,
              messages: [],
              createdAt: event.ts,
            },
          });
          dlog("inspector", this.parentSessionId, `subagent ${agentId} created desc="${desc}" (${this.pendingSpawns.length} pending spawns remain)`, "DEBUG");
        }

        // Route messages — dedup by UUID to prevent 2-3x re-serialized duplicates
        const newMsgs: SubagentMessage[] = [];
        const now = Date.now();
        const isNewUuid = !event.uuid || !this.processedUuids.has(event.uuid);
        if (event.uuid) this.processedUuids.add(event.uuid);

        if (isNewUuid && event.messageType === "assistant") {
          // Extract text and tool messages from assistant content
          if (event.textSnippet) {
            newMsgs.push({ role: "assistant", text: event.textSnippet, timestamp: now });
          }
          if (event.toolAction) {
            const toolName = event.toolNames.length > 0 ? event.toolNames[event.toolNames.length - 1] : undefined;
            // Strip tool name prefix from text — the blue toolName label renders it separately
            let toolText = event.toolAction;
            if (toolName && toolText.startsWith(toolName + ": ")) {
              toolText = toolText.slice(toolName.length + 2);
            }
            newMsgs.push({ role: "tool", text: toolText, toolName, timestamp: now });
            // Nested Agent spawn: queue description for grandchild
            // (subagentType/model not available from toolAction text; filled by SubagentLifecycle if present)
            for (const tn of event.toolNames) {
              if (tn === "Agent" && event.toolAction.startsWith("Agent: ")) {
                this.pendingSpawns.push({ description: event.toolAction.slice(7) });
              }
            }
          }
        }

        // Extract tool result content from sidechain user messages
        if (isNewUuid && event.messageType === "user" && event.toolResultSnippets) {
          for (const snippet of event.toolResultSnippets) {
            if (snippet.content) {
              newMsgs.push({ role: "tool", text: snippet.content, toolName: "result", timestamp: now });
            }
          }
        }

        // Derive state from stopReason
        let state: SessionState = "thinking";
        if (event.messageType === "assistant") {
          if (event.stopReason === "tool_use") state = "toolUse";
          else if (event.stopReason === "end_turn") state = "idle";
          else state = "thinking";
        } else if (event.messageType === "user") {
          state = "thinking";
        } else if (event.messageType === "result") {
          state = "idle";
        }

        this.lastActiveAgent = agentId;
        this.lastEventTs.set(agentId, event.ts || Date.now());
        dlog("inspector", this.parentSessionId, `subagent ${agentId} → ${state} (msgType=${event.messageType} stop=${event.stopReason})`, "DEBUG");

        // Accumulate messages
        const existing = this.subagentMsgs.get(agentId) || [];
        const allMsgs = [...existing, ...newMsgs];

        this.subagentMsgs.set(agentId, allMsgs);

        this.agentStates.set(agentId, state);
        const updatePayload: Partial<Subagent> = {
          state,
          currentAction: event.toolAction,
          messages: allMsgs,
        };
        // Result messages are an authoritative completion signal
        if (event.messageType === "result") {
          updatePayload.completed = true;
        }
        actions.push({
          type: "update",
          subagentId: agentId,
          updates: updatePayload,
        });
        break;
      }

      case "ApiTelemetry":
        // [IN-16] Subagent costUsd tracking: accumulate costUSD from queryDepth>0 events
        if (event.queryDepth > 0 && this.lastActiveAgent) {
          const agentId = this.lastActiveAgent;
          const prev = this.subagentTokens.get(agentId) || 0;
          const newTotal = prev + event.inputTokens + event.outputTokens;
          this.subagentTokens.set(agentId, newTotal);
          const prevCost = this.subagentCost.get(agentId) || 0;
          const newCost = prevCost + event.costUSD;
          this.subagentCost.set(agentId, newCost);
          const updates: Partial<Subagent> = { tokenCount: newTotal, costUsd: newCost };
          if (event.model) updates.model = event.model;
          actions.push({ type: "update", subagentId: agentId, updates });
        }
        break;

      // [IN-30] Capture prompt/result/completed metadata for retained subagent cards + inspector.
      case "SubagentNotification":
        dlog("inspector", this.parentSessionId, `SubagentNotification(${event.status}) → marking all active dead`, "DEBUG");
        if (event.status === "completed" && event.summary && this.lastActiveAgent) {
          // Capture result text on the last active agent before marking all dead
          actions.push({
            type: "update", subagentId: this.lastActiveAgent,
            updates: { resultText: event.summary, completed: true },
          });
        }
        // Mark non-dead agents as completed+dead for clean completions, dead-only for killed.
        // Uses !== "dead" rather than isSubagentActive() so that agents swept idle by the
        // stale-agent timer still receive the authoritative completion signal.
        if (event.status === "completed") {
          for (const agentId of this.knownIds) {
            const currentState = this.agentStates.get(agentId);
            if (currentState && currentState !== "dead") {
              this.agentStates.set(agentId, "dead");
              actions.push({ type: "update", subagentId: agentId, updates: {
                state: "dead",
                completed: true,
                currentToolName: null,
                currentEventKind: null,
                currentAction: null,
              } });
            }
          }
        } else {
          actions.push(...this.markAllActive("dead"));
        }
        break;

      case "UserInterruption":
        this.pendingSpawns = [];
        actions.push(...this.markAllActive("interrupted"));
        break;

      case "SubagentLifecycle": {
        // Enrich subagent data from lifecycle telemetry
        // Find the target agent — use lastActiveAgent since lifecycle events don't carry agentId
        const targetId = this.lastActiveAgent;

        if (event.variant === "start") {
          if (!targetId || !this.knownIds.has(targetId)) break;
          dlog("inspector", this.parentSessionId, `subagent lifecycle start target=${targetId} type=${event.agentType} async=${event.isAsync}`, "DEBUG");
          actions.push({
            type: "update",
            subagentId: targetId,
            updates: {
              agentType: event.agentType || undefined,
              isAsync: event.isAsync ?? undefined,
              model: event.model || undefined,
            },
          });
        } else if (event.variant === "end") {
          dlog("inspector", this.parentSessionId, `subagent lifecycle end target=${targetId} tools=${event.totalToolUses} dur=${event.durationMs}ms`, "DEBUG");
          // Enrich lastActiveAgent with metadata if available
          if (targetId && this.knownIds.has(targetId)) {
            const metaUpdates: Partial<Subagent> = { completed: true };
            if (event.totalToolUses != null) metaUpdates.totalToolUses = event.totalToolUses;
            if (event.durationMs != null) metaUpdates.durationMs = event.durationMs;
            actions.push({ type: "update", subagentId: targetId, updates: metaUpdates });
          }
          // Mark ALL non-dead subagents as completed+dead — lifecycle "end" means the agent turn is done.
          // Targeting all non-dead handles parallel agents where lastActiveAgent may be wrong,
          // and swept-idle agents that should still receive the real completion signal.
          for (const agentId of this.knownIds) {
            const currentState = this.agentStates.get(agentId);
            if (currentState && currentState !== "dead") {
              this.agentStates.set(agentId, "dead");
              actions.push({ type: "update", subagentId: agentId, updates: {
                state: "dead",
                completed: true,
                currentToolName: null,
                currentEventKind: null,
                currentAction: null,
              } });
            }
          }
        } else if (event.variant === "killed") {
          dlog("inspector", this.parentSessionId, `subagent lifecycle killed → marking all active dead`, "DEBUG");
          actions.push(...this.markAllActive("dead"));
        }
        break;
      }

      case "UserInput":
      case "SlashCommand":
        this.sidechainActive = false;
        this.pendingSpawns = [];
        this.seenSpawnFingerprints.clear();
        this.processedUuids.clear();
        // New user prompt → previous turn's agents are done; mark stale active agents idle
        actions.push(...this.markAllActive("idle"));
        break;

      // [IN-26] Route tool activity to active subagent (mirrors parent tab display)
      case "ToolCallStart": {
        if (!this.sidechainActive || !this.lastActiveAgent) break;
        const tgt = this.lastActiveAgent;
        if (!isSubagentActive(this.agentStates.get(tgt) ?? "dead")) break;
        this.lastEventTs.set(tgt, event.ts || Date.now());
        actions.push({
          type: "update", subagentId: tgt,
          updates: { currentToolName: event.toolName, currentEventKind: "ToolCallStart" },
        });
        break;
      }

      case "ToolInput": {
        if (!this.sidechainActive || !this.lastActiveAgent) break;
        const tgt = this.lastActiveAgent;
        if (!isSubagentActive(this.agentStates.get(tgt) ?? "dead")) break;
        this.lastEventTs.set(tgt, event.ts || Date.now());
        const detail = String(
          event.input.command || event.input.file_path || event.input.pattern ||
          event.input.description || event.input.query || ""
        );

        // Enrich the last tool message with structured input for rich rendering.
        // Must create a new object (not mutate in place) so React.memo detects the change.
        const existing = this.subagentMsgs.get(tgt) || [];
        const lastIdx = existing.length - 1;
        if (lastIdx >= 0 && existing[lastIdx].role === "tool" && !existing[lastIdx].toolInput && existing[lastIdx].toolName === event.toolName) {
          const enriched = [...existing];
          enriched[lastIdx] = { ...enriched[lastIdx], toolInput: event.input };
          this.subagentMsgs.set(tgt, enriched);
          actions.push({
            type: "update", subagentId: tgt,
            updates: { currentAction: `${event.toolName}: ${detail}`, messages: enriched },
          });
        } else {
          actions.push({
            type: "update", subagentId: tgt,
            updates: { currentAction: `${event.toolName}: ${detail}` },
          });
        }
        break;
      }

      // [IN-26] TurnEnd(end_turn) transitions active subagent to idle state
      case "TurnEnd": {
        if (!this.sidechainActive || !this.lastActiveAgent) break;
        const tgt = this.lastActiveAgent;
        if (!isSubagentActive(this.agentStates.get(tgt) ?? "dead")) break;
        this.lastEventTs.set(tgt, event.ts || Date.now());
        if (event.stopReason === "end_turn") {
          this.agentStates.set(tgt, "idle");
          actions.push({
            type: "update", subagentId: tgt,
            updates: { state: "idle" as SessionState, currentToolName: null, currentAction: null, currentEventKind: "TurnEnd" },
          });
        }
        break;
      }

      default:
        // Route non-noisy event kinds to active subagent for tab-like activity display
        if (this.sidechainActive && this.lastActiveAgent &&
            !getNoisyEventKinds().has(event.kind) &&
            isSubagentActive(this.agentStates.get(this.lastActiveAgent) ?? "dead")) {
          actions.push({
            type: "update", subagentId: this.lastActiveAgent,
            updates: { currentEventKind: event.kind },
          });
        }
        break;
    }

    return actions;
  }

  /** Reset all tracked state. */
  reset(): void {
    this.pendingSpawns = [];
    this.knownIds.clear();
    this.subagentTokens.clear();
    this.subagentCost.clear();
    this.subagentMsgs.clear();
    this.agentStates.clear();
    this.lastEventTs.clear();
    this.lastActiveAgent = null;
    this.sidechainActive = false;
    this.seenSpawnFingerprints.clear();
    this.consumedSpawnFingerprints.clear();
    this.processedUuids.clear();
  }
}
