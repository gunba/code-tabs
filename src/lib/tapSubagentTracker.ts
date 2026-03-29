import type { TapEvent } from "../types/tapEvents";
import type { Subagent, SubagentMessage, SessionState } from "../types/session";
import { isSubagentActive } from "../types/session";

export interface SubagentAction {
  type: "add" | "update" | "clearIdle";
  subagentId?: string;
  subagent?: Subagent;
  updates?: Partial<Subagent>;
}

/**
 * Tracks subagent lifecycles from tap events.
 * One instance per session. Emits SubagentActions for the store.
 *
 * Replaces the agentId routing in INSTALL_HOOK (lines 90-162) and
 * subagent processing in useInspectorState (lines 218-248).
 */
export class TapSubagentTracker {
  private parentSessionId: string;
  private pendingDescs: string[] = [];
  private knownIds = new Set<string>();
  private subagentTokens = new Map<string, number>(); // agentId → accumulated tokens
  private subagentCost = new Map<string, number>();   // agentId → accumulated costUsd
  private subagentMsgs = new Map<string, SubagentMessage[]>(); // agentId → messages
  private agentStates = new Map<string, SessionState>();
  private lastActiveAgent: string | null = null;

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

  /** Mark all active subagents with the given state, returning update actions. */
  private markAllActive(targetState: SessionState): SubagentAction[] {
    const actions: SubagentAction[] = [];
    for (const agentId of this.knownIds) {
      const currentState = this.agentStates.get(agentId);
      if (currentState && isSubagentActive(currentState)) {
        this.agentStates.set(agentId, targetState);
        actions.push({ type: "update", subagentId: agentId, updates: { state: targetState } });
      }
    }
    return actions;
  }

  /** Process an event. Returns actions to apply to the store, or empty array. */
  process(event: TapEvent): SubagentAction[] {
    const actions: SubagentAction[] = [];

    switch (event.kind) {
      case "SubagentSpawn":
        // Agent tool input with description + prompt → queue description
        this.pendingDescs.push(event.description);
        break;

      case "ConversationMessage": {
        if (!event.isSidechain || !event.agentId) break;

        const agentId = event.agentId;

        // Don't re-activate agents already marked idle/dead by SubagentNotification,
        // SubagentLifecycle, or UserInterruption. Late sidechain messages arriving after
        // completion should not flip hasActiveAgents() back to true.
        if (this.knownIds.has(agentId) && !isSubagentActive(this.agentStates.get(agentId) ?? "dead")) break;

        // First message from a new subagent → create it
        if (!this.knownIds.has(agentId)) {
          this.knownIds.add(agentId);
          this.agentStates.set(agentId, "starting");
          const desc = this.pendingDescs.shift() || "Agent";
          this.subagentTokens.set(agentId, 0);
          this.subagentMsgs.set(agentId, []);

          // Clear idle subagents before adding new one
          actions.push({ type: "clearIdle" });
          actions.push({
            type: "add",
            subagent: {
              id: agentId,
              parentSessionId: this.parentSessionId,
              state: "starting" as SessionState,
              description: desc,
              tokenCount: 0,
              currentAction: null,
              messages: [],
            },
          });
        }

        // Route messages
        const newMsgs: SubagentMessage[] = [];
        const now = Date.now();

        if (event.messageType === "assistant") {
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
            for (const tn of event.toolNames) {
              if (tn === "Agent" && event.toolAction.startsWith("Agent: ")) {
                this.pendingDescs.push(event.toolAction.slice(7).slice(0, 100));
              }
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

        // Accumulate messages
        const existing = this.subagentMsgs.get(agentId) || [];
        const allMsgs = [...existing, ...newMsgs];
        const capped = allMsgs.length > 200 ? allMsgs.slice(-200) : allMsgs;
        this.subagentMsgs.set(agentId, capped);

        this.agentStates.set(agentId, state);
        actions.push({
          type: "update",
          subagentId: agentId,
          updates: {
            state,
            currentAction: event.toolAction,
            messages: capped,
          },
        });
        break;
      }

      case "ApiTelemetry":
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

      case "SubagentNotification":
        actions.push(...this.markAllActive("dead"));
        break;

      case "UserInterruption":
        actions.push(...this.markAllActive("interrupted"));
        break;

      case "SubagentLifecycle": {
        // Enrich subagent data from lifecycle telemetry
        // Find the target agent — use lastActiveAgent since lifecycle events don't carry agentId
        const targetId = this.lastActiveAgent;

        if (event.variant === "start") {
          if (!targetId || !this.knownIds.has(targetId)) break;
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
          // Enrich lastActiveAgent with metadata if available
          if (targetId && this.knownIds.has(targetId)) {
            const metaUpdates: Partial<Subagent> = {};
            if (event.totalToolUses != null) metaUpdates.totalToolUses = event.totalToolUses;
            if (event.durationMs != null) metaUpdates.durationMs = event.durationMs;
            if (Object.keys(metaUpdates).length > 0) {
              actions.push({ type: "update", subagentId: targetId, updates: metaUpdates });
            }
          }
          // Mark ALL active subagents as dead — lifecycle "end" means the agent turn is done.
          // Targeting all active handles parallel agents where lastActiveAgent may be wrong.
          actions.push(...this.markAllActive("dead"));
        } else if (event.variant === "killed") {
          actions.push(...this.markAllActive("dead"));
        }
        break;
      }

      case "UserInput":
      case "SlashCommand":
        // New user prompt → previous turn's agents are done; mark stale active agents idle
        actions.push(...this.markAllActive("idle"));
        break;

      default:
        break;
    }

    return actions;
  }

  /** Reset all tracked state. */
  reset(): void {
    this.pendingDescs = [];
    this.knownIds.clear();
    this.subagentTokens.clear();
    this.subagentCost.clear();
    this.subagentMsgs.clear();
    this.agentStates.clear();
    this.lastActiveAgent = null;
  }
}
