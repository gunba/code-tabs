import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { settledStateManager } from "../settledState";

// Mock dlog to avoid side effects
vi.mock("../debugLog", () => ({
  dlog: vi.fn(),
}));

describe("settledStateManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    settledStateManager.removeSession("s1");
    settledStateManager.removeSession("s2");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles idle after 2s hysteresis", () => {
    const onSettle = vi.fn();
    const onClear = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, onClear);

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "idle");

    // Not settled yet
    expect(onSettle).not.toHaveBeenCalled();
    expect(settledStateManager.getSettled("s1")).toBeNull();

    // After 2s, settled
    vi.advanceTimersByTime(2000);
    expect(onSettle).toHaveBeenCalledWith("s1", "idle");
    expect(settledStateManager.getSettled("s1")).toBe("idle");

    unsub();
  });

  it("cancels idle hysteresis on transient idle (non-idle → idle → non-idle within 2s)", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "idle");

    vi.advanceTimersByTime(500);
    settledStateManager.update("s1", "thinking"); // Transient — back to work

    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();
    expect(settledStateManager.getSettled("s1")).toBeNull();

    unsub();
  });

  it("settles actionNeeded immediately (no hysteresis)", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "actionNeeded");

    expect(onSettle).toHaveBeenCalledWith("s1", "actionNeeded");
    expect(settledStateManager.getSettled("s1")).toBe("actionNeeded");

    unsub();
  });

  it("settles waitingPermission immediately", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "toolUse");
    settledStateManager.update("s1", "waitingPermission");

    expect(onSettle).toHaveBeenCalledWith("s1", "waitingPermission");
    expect(settledStateManager.getSettled("s1")).toBe("waitingPermission");

    unsub();
  });

  it("auto-clears when state leaves settled kind", () => {
    const onSettle = vi.fn();
    const onClear = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, onClear);

    // Settle into idle
    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "idle");
    vi.advanceTimersByTime(2000);
    expect(onSettle).toHaveBeenCalledWith("s1", "idle");

    // Session resumes work → auto-clear
    settledStateManager.update("s1", "thinking");
    expect(onClear).toHaveBeenCalledWith("s1");
    expect(settledStateManager.getSettled("s1")).toBeNull();

    unsub();
  });

  it("auto-clears actionNeeded when session resumes", () => {
    const onClear = vi.fn();
    const unsub = settledStateManager.subscribe(() => {}, onClear);

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "actionNeeded");
    settledStateManager.update("s1", "thinking"); // User answered

    expect(onClear).toHaveBeenCalledWith("s1");
    expect(settledStateManager.getSettled("s1")).toBeNull();

    unsub();
  });

  it("manual clearSettled fires clear callback", () => {
    const onClear = vi.fn();
    const unsub = settledStateManager.subscribe(() => {}, onClear);

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "actionNeeded");
    settledStateManager.clearSettled("s1");

    expect(onClear).toHaveBeenCalledWith("s1");
    expect(settledStateManager.getSettled("s1")).toBeNull();

    unsub();
  });

  it("clearSettled cancels pending idle timer", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "idle");
    settledStateManager.clearSettled("s1"); // Cancel before hysteresis

    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();

    unsub();
  });

  it("manages multiple sessions independently", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s2", "thinking");
    settledStateManager.update("s1", "idle");

    vi.advanceTimersByTime(1000);
    settledStateManager.update("s2", "idle");

    // s1 settles at 2000ms
    vi.advanceTimersByTime(1000);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith("s1", "idle");

    // s2 settles at 3000ms
    vi.advanceTimersByTime(1000);
    expect(onSettle).toHaveBeenCalledTimes(2);
    expect(onSettle).toHaveBeenCalledWith("s2", "idle");

    unsub();
  });

  it("removeSession cleans up timers and state", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "idle");
    settledStateManager.removeSession("s1");

    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();
    expect(settledStateManager.getSettled("s1")).toBeNull();

    unsub();
  });

  it("unsubscribe stops callbacks", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    unsub();

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "actionNeeded");
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("does not re-settle to the same kind", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "actionNeeded");
    expect(onSettle).toHaveBeenCalledTimes(1);

    // Same state again — no duplicate
    settledStateManager.update("s1", "actionNeeded");
    expect(onSettle).toHaveBeenCalledTimes(1);

    unsub();
  });

  it("does not settle on same-state updates", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "idle");
    settledStateManager.update("s1", "idle");
    settledStateManager.update("s1", "idle");

    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();

    unsub();
  });

  it("transitions between settled kinds (idle → actionNeeded)", () => {
    const onSettle = vi.fn();
    const onClear = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, onClear);

    // Settle into idle
    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "idle");
    vi.advanceTimersByTime(2000);
    expect(onSettle).toHaveBeenCalledWith("s1", "idle");

    // Transition to actionNeeded — should clear idle then settle actionNeeded
    settledStateManager.update("s1", "actionNeeded");
    expect(onClear).toHaveBeenCalledWith("s1");
    expect(onSettle).toHaveBeenCalledWith("s1", "actionNeeded");
    expect(settledStateManager.getSettled("s1")).toBe("actionNeeded");

    unsub();
  });

  it("does not settle for sessions that were never meaningfully active", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "idle");
    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();

    settledStateManager.update("s1", "starting");
    settledStateManager.update("s1", "idle");
    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();

    unsub();
  });

  it("does not re-settle idle after manual clear without new activity", () => {
    const onSettle = vi.fn();
    const onClear = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, onClear);

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "idle");
    vi.advanceTimersByTime(2000);
    expect(onSettle).toHaveBeenCalledWith("s1", "idle");

    settledStateManager.clearSettled("s1");
    vi.advanceTimersByTime(2000);
    expect(onClear).toHaveBeenCalledWith("s1");
    expect(onSettle).toHaveBeenCalledTimes(1);

    unsub();
  });

  it("treats interrupted as meaningful previous activity before settling idle", () => {
    const onSettle = vi.fn();
    const unsub = settledStateManager.subscribe(onSettle, () => {});

    settledStateManager.update("s1", "thinking");
    settledStateManager.update("s1", "interrupted");

    vi.advanceTimersByTime(2000);
    expect(onSettle).toHaveBeenCalledWith("s1", "idle");

    unsub();
  });
});
