// [SE-01] Centralized per-session settled-state hysteresis for idle/actionNeeded/waitingPermission
import type { SessionState } from "../types/session";
import { isSessionIdle } from "../types/session";
import { dlog } from "./debugLog";

export type SettledKind = "idle" | "actionNeeded" | "waitingPermission";

type SettledCallback = (sessionId: string, kind: SettledKind) => void;
type ClearCallback = (sessionId: string) => void;

interface Subscriber {
  onSettle: SettledCallback;
  onClear: ClearCallback;
}

const IDLE_HYSTERESIS_MS = 2000;

/**
 * Manages per-session hysteresis for idle/actionNeeded/waitingPermission state transitions.
 * Fed by effective state (accounting for subagents) from a single Zustand effect.
 * Consumers subscribe for settle/clear callbacks instead of implementing their own debounce.
 */
class SettledStateManager {
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastEffState = new Map<string, SessionState>();
  private settledKinds = new Map<string, SettledKind>();
  private subscribers = new Set<Subscriber>();

  subscribe(onSettle: SettledCallback, onClear: ClearCallback): () => void {
    const sub: Subscriber = { onSettle, onClear };
    this.subscribers.add(sub);
    return () => { this.subscribers.delete(sub); };
  }

  /** Feed an effective-state update for a session. Called from the Zustand effect in App.tsx. */
  update(sessionId: string, effState: SessionState): void {
    const prev = this.lastEffState.get(sessionId);
    this.lastEffState.set(sessionId, effState);

    if (prev === effState) return;

    // Auto-clear: if session leaves a settled state (user sent input, work resumed)
    if (this.settledKinds.has(sessionId)) {
      const currentKind = this.settledKinds.get(sessionId)!;
      const stillSettled =
        (currentKind === "idle" && isSessionIdle(effState)) ||
        (currentKind === "actionNeeded" && effState === "actionNeeded") ||
        (currentKind === "waitingPermission" && effState === "waitingPermission");
      if (!stillSettled) {
        this.doClear(sessionId);
      }
    }

    // Cancel pending idle timer if state is no longer idle
    if (!isSessionIdle(effState)) {
      const pending = this.pendingTimers.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        this.pendingTimers.delete(sessionId);
        dlog("settled", sessionId, "idle hysteresis cancelled (transient)", "DEBUG");
      }
    }

    // Immediate settle for actionNeeded / waitingPermission
    if (effState === "actionNeeded" || effState === "waitingPermission") {
      this.doSettle(sessionId, effState);
      return;
    }

    // Start hysteresis timer for idle transitions
    if (isSessionIdle(effState) && prev && !isSessionIdle(prev) && prev !== "dead" && prev !== "starting") {
      // Cancel any existing pending timer (shouldn't happen, but defensive)
      const existing = this.pendingTimers.get(sessionId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.pendingTimers.delete(sessionId);
        // Verify state is still idle when timer fires
        const currentEff = this.lastEffState.get(sessionId);
        if (currentEff && isSessionIdle(currentEff)) {
          dlog("settled", sessionId, "idle confirmed after hysteresis");
          this.doSettle(sessionId, "idle");
        }
      }, IDLE_HYSTERESIS_MS);
      this.pendingTimers.set(sessionId, timer);
    }
  }

  /** Manual clear — called on tab click, hover, or input send. */
  clearSettled(sessionId: string): void {
    if (this.settledKinds.has(sessionId)) {
      this.doClear(sessionId);
    }
    // Also cancel any pending timer
    const pending = this.pendingTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.pendingTimers.delete(sessionId);
    }
  }

  /** Query current settled state. */
  getSettled(sessionId: string): SettledKind | null {
    return this.settledKinds.get(sessionId) ?? null;
  }

  /** Cleanup on session close. */
  removeSession(sessionId: string): void {
    const pending = this.pendingTimers.get(sessionId);
    if (pending) clearTimeout(pending);
    this.pendingTimers.delete(sessionId);
    this.lastEffState.delete(sessionId);
    if (this.settledKinds.has(sessionId)) {
      this.settledKinds.delete(sessionId);
      // Don't fire clear callbacks on removal — session is gone
    }
  }

  /** Returns all session IDs currently tracked (for cleanup of removed sessions). */
  _getTrackedSessions(): Iterable<string> {
    return this.lastEffState.keys();
  }

  private doSettle(sessionId: string, kind: SettledKind): void {
    if (this.settledKinds.get(sessionId) === kind) return; // Already settled to this kind
    this.settledKinds.set(sessionId, kind);
    for (const sub of this.subscribers) {
      sub.onSettle(sessionId, kind);
    }
  }

  private doClear(sessionId: string): void {
    this.settledKinds.delete(sessionId);
    for (const sub of this.subscribers) {
      sub.onClear(sessionId);
    }
  }
}

export const settledStateManager = new SettledStateManager();
