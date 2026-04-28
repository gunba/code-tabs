import type { TapEvent } from "../types/tapEvents";

type TapEventHandler = (event: TapEvent) => void;

/**
 * Per-session synchronous pub/sub for classified tap events.
 * Module-level singleton. Subscribers registered per sessionId.
 * dispatchBatch() processes all events atomically to prevent intermediate state flicker.
 */
class TapEventBus {
  private handlers = new Map<string, Set<TapEventHandler>>();

  /** Subscribe to events for a session. Returns unsubscribe function. */
  subscribe(sessionId: string, handler: TapEventHandler): () => void {
    let set = this.handlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.handlers.set(sessionId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(sessionId);
    };
  }

  /** Dispatch a single event to all subscribers for a session. */
  dispatch(sessionId: string, event: TapEvent): void {
    const set = this.handlers.get(sessionId);
    if (!set) return;
    for (const handler of set) {
      handler(event);
    }
  }

  /** Dispatch a batch of events atomically. */
  dispatchBatch(sessionId: string, events: TapEvent[]): void {
    const set = this.handlers.get(sessionId);
    if (!set || events.length === 0) return;
    for (const event of events) {
      for (const handler of set) {
        handler(event);
      }
    }
  }

  /** Remove all subscribers for a session. */
  clear(sessionId: string): void {
    this.handlers.delete(sessionId);
  }
}

export const tapEventBus = new TapEventBus();
