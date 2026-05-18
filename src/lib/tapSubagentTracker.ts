import type { TapEvent } from "../types/tapEvents";
import type { Subagent, SubagentMessage, SessionState } from "../types/session";
import { isSubagentActive } from "../types/session";
import { getNoisyEventKinds } from "./noisyEventKinds";
import { dlog } from "./debugLog";

const INTERNAL_ASIDE_QUESTION_AGENT_PREFIX = "aside_question";

// [IN-35] CodexSubagentSpawned/Status events create and update retained subagent cards.
function codexStateFromStatus(status: string | null): SessionState {
  switch (status) {
    case "pending_init":
      return "starting";
    case "running":
      return "thinking";
    case "interrupted":
      return "interrupted";
    case "completed":
    case "errored":
    case "shutdown":
    case "not_found":
      return "dead";
    default:
      return "thinking";
  }
}

function isCodexCompletedStatus(status: string | null): boolean {
  return status === "completed";
}

export interface SubagentAction {
  type: "add" | "update" | "remove";
  subagentId?: string;
  subagent?: Subagent;
  updates?: Partial<Subagent>;
}

// [SI-09] Subagent data captured via inspector tap events (no JSONL watcher)
// [IN-03] Subagent tracking: Agent tool_use -> queue spawn -> first sidechain msg creates entry; pendingSpawns drained on UserInterruption/UserInput/SlashCommand
// [SR-05] Nested subagents supported via agentId-based routing (each event tagged with agentId, parentSessionId tracked)
/**
 * Tracks subagent lifecycles from tap events.
 * One instance per session. Emits SubagentActions for the store.
 *
 * Replaces the old agentId-routed inspector path and the former
 * useInspectorState subagent processing.
 */
type PendingSpawn = { description: string; prompt?: string; subagentType?: string; model?: string };

// FIFO cap for retained completed subagent cards per parent session.
// When the count exceeds this, the oldest is evicted from the UI.
const COMPLETED_SUBAGENT_CAP = 10;

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
  private lastMainToolCall: string | null = null; // last non-sidechain ToolCallStart tool name
  private lastUnnamedAgentId: string | null = null; // agentId that received "Agent" fallback description
  private codexSubagentIds = new Set<string>();
  // FIFO of agentIds in the order they first transitioned to dead. Drives eviction
  // when retained completed cards exceed COMPLETED_SUBAGENT_CAP.
  private deadOrder: string[] = [];

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

  /** The tool name from the most recent non-sidechain ToolCallStart, or null. */
  getLastMainToolCall(): string | null {
    return this.lastMainToolCall;
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
        if (targetState === "dead") {
          this.recordDead(agentId, actions);
        }
      }
    }
    return actions;
  }

  /** Track a subagent's first transition to dead in FIFO order. When more than
   *  COMPLETED_SUBAGENT_CAP cards have accumulated, push a remove action for
   *  the oldest dead agent and drop it from internal tracking. */
  private recordDead(agentId: string, actions: SubagentAction[]): void {
    if (this.deadOrder.includes(agentId)) return;
    this.deadOrder.push(agentId);
    while (this.deadOrder.length > COMPLETED_SUBAGENT_CAP) {
      const evict = this.deadOrder.shift()!;
      this.knownIds.delete(evict);
      this.agentStates.delete(evict);
      this.subagentTokens.delete(evict);
      this.subagentCost.delete(evict);
      this.subagentMsgs.delete(evict);
      this.lastEventTs.delete(evict);
      this.codexSubagentIds.delete(evict);
      if (this.lastActiveAgent === evict) this.lastActiveAgent = null;
      if (this.lastUnnamedAgentId === evict) this.lastUnnamedAgentId = null;
      actions.push({ type: "remove", subagentId: evict });
      dlog("inspector", this.parentSessionId, `subagent ${evict} evicted (FIFO cap=${COMPLETED_SUBAGENT_CAP})`, "DEBUG");
    }
  }

  /** Sweep every non-dead known subagent to dead+completed, emitting update +
   *  FIFO-eviction actions. Used by every clean-completion code path.
   *
   *  [IN-36] Insta-complete fix: subagents that have not yet shown a single
   *  conversation message are marked dead but NOT completed=true, so the
   *  SubagentBar renders them as a neutral "dead" card instead of stamping a
   *  green checkmark on an agent the user has never seen working. Late
   *  sidechain messages can still arrive via the transcript-only append path
   *  in the ConversationMessage handler. */
  private sweepNonDeadToDead(actions: SubagentAction[], reason: string): void {
    for (const agentId of this.knownIds) {
      const currentState = this.agentStates.get(agentId);
      if (currentState && currentState !== "dead") {
        const hasMessages = (this.subagentMsgs.get(agentId)?.length ?? 0) > 0;
        dlog("inspector", this.parentSessionId, `subagent ${agentId} ${currentState} → dead${hasMessages ? "+completed" : ""} (${reason})`, "DEBUG");
        this.agentStates.set(agentId, "dead");
        const updates: Partial<Subagent> = {
          state: "dead",
          currentToolName: null,
          currentEventKind: null,
          currentAction: null,
        };
        if (hasMessages) {
          updates.completed = true;
        }
        actions.push({ type: "update", subagentId: agentId, updates });
        this.recordDead(agentId, actions);
      }
    }
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
        // Late spawn: if an agent was already created with the "Agent" fallback,
        // retroactively patch it instead of queuing (the queue was empty when the
        // first sidechain ConversationMessage arrived before this SubagentSpawn).
        if (this.lastUnnamedAgentId) {
          const targetId = this.lastUnnamedAgentId;
          this.lastUnnamedAgentId = null;
          this.consumedSpawnFingerprints.add(fingerprint);
          actions.push({
            type: "update", subagentId: targetId,
            updates: {
              description: event.description,
              promptText: event.prompt,
              subagentType: event.subagentType,
              model: event.model,
            },
          });
          dlog("inspector", this.parentSessionId, `subagent ${targetId} retroactively named "${event.description.slice(0, 60)}"`, "DEBUG");
          break;
        }
        this.pendingSpawns.push({
          description: event.description,
          prompt: event.prompt,
          subagentType: event.subagentType,
          model: event.model,
        });
        dlog("inspector", this.parentSessionId, `subagent spawn queued desc="${event.description.slice(0, 60)}"`, "DEBUG");
        break;
      }

      case "CodexSubagentSpawned": {
        if (!event.agentId) break;
        const rawState = codexStateFromStatus(event.status);
        const rawCompleted = isCodexCompletedStatus(event.status);
        // [IN-36] Insta-complete fix: spawn telemetry must not mark an agent
        // dead. The spawn event tells us "this agent now exists"; lifecycle
        // (CodexSubagentStatus) tells us "this agent finished". If we see the
        // agent's status as already completed at spawn time (fast errors,
        // batched rollout reads, etc.) we still create the entry in an active
        // state so the UI doesn't pop straight to checkmark; the next genuine
        // CodexSubagentStatus(completed) drives the transition.
        const isKnown = this.knownIds.has(event.agentId);
        const state: SessionState = isKnown ? rawState : (rawState === "dead" ? "thinking" : rawState);
        const completed = isKnown ? rawCompleted : false;
        const description = event.nickname || event.role || "Codex agent";
        this.codexSubagentIds.add(event.agentId);
        this.subagentTokens.set(event.agentId, this.subagentTokens.get(event.agentId) ?? 0);
        this.subagentMsgs.set(event.agentId, this.subagentMsgs.get(event.agentId) ?? []);
        this.agentStates.set(event.agentId, state);
        this.lastActiveAgent = event.agentId;
        this.lastEventTs.set(event.agentId, event.ts || Date.now());

        if (this.knownIds.has(event.agentId)) {
          actions.push({
            type: "update",
            subagentId: event.agentId,
            updates: {
              state,
              completed,
              description,
              subagentType: event.role || undefined,
              agentType: event.role || undefined,
              model: event.model || undefined,
              promptText: event.prompt,
              resultText: completed ? (event.statusMessage || undefined) : undefined,
              currentEventKind: "CodexSubagentSpawned",
            },
          });
          if (state === "dead") this.recordDead(event.agentId, actions);
          break;
        }

        this.knownIds.add(event.agentId);
        actions.push({
          type: "add",
          subagent: {
            id: event.agentId,
            parentSessionId: this.parentSessionId,
            state,
            description,
            subagentType: event.role || undefined,
            agentType: event.role || undefined,
            model: event.model || undefined,
            promptText: event.prompt,
            tokenCount: 0,
            currentAction: event.status || null,
            currentToolName: null,
            currentEventKind: "CodexSubagentSpawned",
            messages: [],
            createdAt: event.ts,
            resultText: completed ? (event.statusMessage || undefined) : undefined,
            completed,
          },
        });
        if (state === "dead") this.recordDead(event.agentId, actions);
        dlog("inspector", this.parentSessionId, `codex subagent ${event.agentId} created desc="${description}" status=${event.status}`, "DEBUG");
        break;
      }

      case "CodexSubagentStatus": {
        if (!event.agentId) break;
        const rawState = codexStateFromStatus(event.status);
        const rawCompleted = isCodexCompletedStatus(event.status);
        // [IN-36] Insta-complete fix mirror: when we encounter a status event
        // for an agent we've never seen before, treat it like a spawn and
        // keep the entry alive until at least one further telemetry event
        // confirms the dead transition. Updates to known agents keep their
        // genuine lifecycle semantics.
        const isKnown = this.knownIds.has(event.agentId);
        const state: SessionState = isKnown ? rawState : (rawState === "dead" ? "thinking" : rawState);
        const completed = isKnown ? rawCompleted : false;
        this.codexSubagentIds.add(event.agentId);
        this.agentStates.set(event.agentId, state);
        this.lastActiveAgent = event.agentId;
        this.lastEventTs.set(event.agentId, event.ts || Date.now());
        const description = event.nickname || event.role || "Codex agent";
        const updates: Partial<Subagent> = {
          state,
          completed,
          currentAction: event.status,
          currentToolName: null,
          currentEventKind: "CodexSubagentStatus",
        };
        if (event.role) {
          updates.subagentType = event.role;
          updates.agentType = event.role;
        }
        if (completed && event.statusMessage) updates.resultText = event.statusMessage;

        if (isKnown) {
          actions.push({ type: "update", subagentId: event.agentId, updates });
        } else {
          this.knownIds.add(event.agentId);
          this.subagentTokens.set(event.agentId, 0);
          this.subagentMsgs.set(event.agentId, []);
          actions.push({
            type: "add",
            subagent: {
              id: event.agentId,
              parentSessionId: this.parentSessionId,
              state,
              description,
              subagentType: event.role || undefined,
              agentType: event.role || undefined,
              tokenCount: 0,
              currentAction: event.status,
              currentToolName: null,
              currentEventKind: "CodexSubagentStatus",
              messages: [],
              createdAt: event.ts,
              resultText: completed ? (event.statusMessage || undefined) : undefined,
              completed,
            },
          });
        }
        if (state === "dead") this.recordDead(event.agentId, actions);
        dlog("inspector", this.parentSessionId, `codex subagent ${event.agentId} status=${event.status}`, "DEBUG");
        break;
      }

      case "ConversationMessage": {
        // Track sidechain state for routing non-ConversationMessage events
        const wasSidechainActive = this.sidechainActive;
        this.sidechainActive = event.isSidechain;
        // Sidechain-exit completion: parent agent resumed → every still-live
        // subagent is done. Sweeps all non-dead agents (not just "idle") because
        // the TurnEnd→idle hop was removed: a parent SSE TurnEnd arriving while
        // sidechainActive was stale used to mark a still-working subagent idle,
        // and the next ConvMessage promoted that idle→dead. Subagents now only
        // terminate via explicit lifecycle signals or this sweep at real exit.
        if (wasSidechainActive && !event.isSidechain) {
          this.sweepNonDeadToDead(actions, "sidechain exit");
        }
        // [IN-04] Subagent messages: isSidechain + agentId routing, late msg gating
        if (!event.isSidechain || !event.agentId) break;

        const agentId = event.agentId;

        // [IN-37] Late sidechain message → still append to the transcript even
        // when the agent is no longer active. Decouples lifecycle authority
        // (SubagentNotification / SubagentLifecycle / sidechain-exit sweep)
        // from transcript completeness so the inspector renders real content
        // even after the subagent has been swept dead. Skip state/lastActive
        // updates so hasActiveAgents() does not flip back to true.
        if (this.knownIds.has(agentId) && !isSubagentActive(this.agentStates.get(agentId) ?? "dead")) {
          const now = Date.now();
          const isNewUuid = !event.uuid || !this.processedUuids.has(event.uuid);
          if (!isNewUuid) {
            dlog("inspector", this.parentSessionId, `subagent ${agentId} late msg dedup'd uuid=${event.uuid}`, "DEBUG");
            break;
          }
          if (event.uuid) this.processedUuids.add(event.uuid);
          const lateMsgs: SubagentMessage[] = [];
          if (event.messageType === "assistant") {
            if (event.textSnippet) {
              lateMsgs.push({ role: "assistant", text: event.textSnippet, timestamp: now });
            }
            if (event.toolAction) {
              const toolName = event.toolNames.length > 0 ? event.toolNames[event.toolNames.length - 1] : undefined;
              let toolText = event.toolAction;
              if (toolName && toolText.startsWith(toolName + ": ")) {
                toolText = toolText.slice(toolName.length + 2);
              }
              lateMsgs.push({ role: "tool", text: toolText, toolName, timestamp: now });
            }
          }
          if (event.messageType === "user" && event.toolResultSnippets) {
            for (const snippet of event.toolResultSnippets) {
              if (snippet.content) {
                lateMsgs.push({ role: "tool", text: snippet.content, toolName: "result", timestamp: now });
              }
            }
          }
          if (lateMsgs.length > 0) {
            const existing = this.subagentMsgs.get(agentId) || [];
            const allMsgs = [...existing, ...lateMsgs];
            this.subagentMsgs.set(agentId, allMsgs);
            actions.push({
              type: "update",
              subagentId: agentId,
              updates: { messages: allMsgs },
            });
            dlog("inspector", this.parentSessionId, `subagent ${agentId} late msg appended (state=${this.agentStates.get(agentId)}) +${lateMsgs.length}`, "DEBUG");
          }
          break;
        }

        // First message from a new subagent → create it
        if (!this.knownIds.has(agentId)) {
          // [IN-03] Skip CLI-internal sidechains (aside_question replays parent context,
          // creating a phantom entry that duplicates a real agent)
          if (agentId.startsWith(INTERNAL_ASIDE_QUESTION_AGENT_PREFIX)) {
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
          } else {
            this.lastUnnamedAgentId = agentId;
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
        // Subagent completion is signaled by SubagentNotification and SubagentLifecycle "end"
        // only — those paths also clear transient tool state. Do not mark completed here on
        // messageType "result" or the agent flips done mid-turn while still using tools.
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
      case "SubagentNotification": {
        dlog("inspector", this.parentSessionId, `SubagentNotification(${event.status}) → marking all active dead`, "DEBUG");
        const resultText = event.result || event.summary;
        if (event.status === "completed" && resultText && this.lastActiveAgent) {
          // Capture result text on the last active agent before marking all dead.
          // Prefer the <result> tag body (LocalAgentTask emits the final assistant
          // message there); fall back to <summary>.
          actions.push({
            type: "update", subagentId: this.lastActiveAgent,
            updates: { resultText, completed: true },
          });
        }
        // Mark non-dead agents as completed+dead for clean completions, dead-only for
        // any non-success terminal state (killed | failed | stopped).
        // Uses !== "dead" rather than isSubagentActive() so that agents swept idle by the
        // stale-agent timer still receive the authoritative completion signal.
        if (event.status === "completed") {
          this.sweepNonDeadToDead(actions, "SubagentNotification(completed)");
        } else {
          actions.push(...this.markAllActive("dead"));
        }
        break;
      }

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
          // Enrich lastActiveAgent with metadata if available.
          // [IN-36] Only stamp completed=true when the agent has accumulated
          // at least one conversation message, so 0-message agents render as
          // a neutral dead card rather than a green checkmark on something
          // the user never saw working.
          if (targetId && this.knownIds.has(targetId)) {
            const hasMessages = (this.subagentMsgs.get(targetId)?.length ?? 0) > 0;
            const metaUpdates: Partial<Subagent> = {};
            if (hasMessages) metaUpdates.completed = true;
            if (event.totalToolUses != null) metaUpdates.totalToolUses = event.totalToolUses;
            if (event.durationMs != null) metaUpdates.durationMs = event.durationMs;
            actions.push({ type: "update", subagentId: targetId, updates: metaUpdates });
          }
          // Mark ALL non-dead subagents as completed+dead — lifecycle "end" means the agent turn is done.
          // Targeting all non-dead handles parallel agents where lastActiveAgent may be wrong,
          // and swept-idle agents that should still receive the real completion signal.
          this.sweepNonDeadToDead(actions, "SubagentLifecycle(end)");
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
        this.lastMainToolCall = null;
        this.lastUnnamedAgentId = null;
        // New user prompt → previous turn's agents are done; mark stale active agents idle
        actions.push(...this.markAllActive("idle"));
        // Sweep idle agents to dead+completed — a new user prompt is an authoritative
        // signal that all previous subagent work is finished. Completed cards are
        // retained (up to COMPLETED_SUBAGENT_CAP, FIFO) so the user can review them.
        for (const agentId of this.knownIds) {
          if (this.agentStates.get(agentId) === "idle") {
            dlog("inspector", this.parentSessionId, `subagent ${agentId} idle → dead+completed (new user prompt)`, "DEBUG");
            this.agentStates.set(agentId, "dead");
            actions.push({ type: "update", subagentId: agentId, updates: {
              state: "dead",
              completed: true,
              currentToolName: null,
              currentEventKind: null,
              currentAction: null,
            } });
            this.recordDead(agentId, actions);
          }
        }
        break;

      case "CodexTaskComplete":
        for (const agentId of this.codexSubagentIds) {
          if (isSubagentActive(this.agentStates.get(agentId) ?? "dead")) {
            this.agentStates.set(agentId, "idle");
            actions.push({ type: "update", subagentId: agentId, updates: {
              state: "idle",
              currentToolName: null,
              currentEventKind: null,
              currentAction: null,
            } });
          }
        }
        break;

      // [IN-26] Route tool activity to active subagent (mirrors parent tab display)
      case "ToolCallStart": {
        // Track main-agent tool calls for phantom ToolInput suppression
        if (!this.sidechainActive) this.lastMainToolCall = event.toolName;
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

      // [IN-26] TurnEnd handling removed: sidechainActive is stale during the
      // window between a sidechain assistant ConvMessage and the parent's next
      // non-sidechain ConvMessage, so a parent SSE TurnEnd would mark the
      // running subagent idle and the next ConvMessage swept idle → dead.
      // Subagent termination now flows through SubagentLifecycle/Notification
      // or the sidechain-exit sweep (which now covers all non-dead agents).

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
    this.lastMainToolCall = null;
    this.lastUnnamedAgentId = null;
    this.codexSubagentIds.clear();
    this.deadOrder = [];
  }
}
