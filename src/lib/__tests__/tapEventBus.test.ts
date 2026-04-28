import { describe, it, expect, vi, beforeEach } from "vitest";
import { tapEventBus } from "../tapEventBus";
import type { TapEvent } from "../../types/tapEvents";

const makeEvent = (_kind: string, ts = 0): TapEvent =>
  ({ kind: "ThinkingStart", ts, index: 0 }) as TapEvent;

describe("tapEventBus", () => {
  beforeEach(() => {
    tapEventBus.clear("test-session");
  });

  it("dispatches events to subscribers", () => {
    const handler = vi.fn();
    tapEventBus.subscribe("test-session", handler);
    const event = makeEvent("ThinkingStart");
    tapEventBus.dispatch("test-session", event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("does not dispatch to other sessions", () => {
    const handler = vi.fn();
    tapEventBus.subscribe("session-a", handler);
    tapEventBus.dispatch("session-b", makeEvent("ThinkingStart"));
    expect(handler).not.toHaveBeenCalled();
    tapEventBus.clear("session-a");
  });

  it("supports multiple subscribers", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    tapEventBus.subscribe("test-session", h1);
    tapEventBus.subscribe("test-session", h2);
    tapEventBus.dispatch("test-session", makeEvent("ThinkingStart"));
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes handler", () => {
    const handler = vi.fn();
    const unsub = tapEventBus.subscribe("test-session", handler);
    unsub();
    tapEventBus.dispatch("test-session", makeEvent("ThinkingStart"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatchBatch sends each event to all handlers before the next event", () => {
    const calls: string[] = [];
    const h1 = vi.fn((event: TapEvent) => calls.push(`h1:${event.ts}`));
    const h2 = vi.fn((event: TapEvent) => calls.push(`h2:${event.ts}`));
    tapEventBus.subscribe("test-session", h1);
    tapEventBus.subscribe("test-session", h2);
    const events = [makeEvent("ThinkingStart", 1), makeEvent("ThinkingStart", 2)];
    tapEventBus.dispatchBatch("test-session", events);
    expect(h1).toHaveBeenCalledTimes(2);
    expect(h2).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["h1:1", "h2:1", "h1:2", "h2:2"]);
  });

  it("dispatchBatch is no-op for empty events", () => {
    const handler = vi.fn();
    tapEventBus.subscribe("test-session", handler);
    tapEventBus.dispatchBatch("test-session", []);
    expect(handler).not.toHaveBeenCalled();
  });

  it("clear removes all handlers for a session", () => {
    const handler = vi.fn();
    tapEventBus.subscribe("test-session", handler);
    tapEventBus.clear("test-session");
    tapEventBus.dispatch("test-session", makeEvent("ThinkingStart"));
    expect(handler).not.toHaveBeenCalled();
  });
});
