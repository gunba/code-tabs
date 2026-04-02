import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Provide a minimal `window` global for Node ─────────────────────────

type Handler = (e: Partial<KeyboardEvent>) => void;
let listeners: Map<string, Handler[]>;

const fakeWindow = {
  addEventListener: vi.fn((event: string, handler: Handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(handler);
  }),
  removeEventListener: vi.fn((event: string, handler: Handler) => {
    const arr = listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }),
};

// Install before any import that touches `window`
(globalThis as Record<string, unknown>).window = fakeWindow;

// ── Capture React hook calls ────────────────────────────────────────────

type EffectFn = () => (() => void) | void;
let lastEffect: EffectFn | null = null;
let stateValue = false;

vi.mock("react", () => ({
  useState: (init: boolean) => {
    stateValue = init;
    const setter = (v: boolean) => { stateValue = v; };
    return [init, setter];
  },
  useEffect: (fn: EffectFn, _deps?: unknown[]) => {
    lastEffect = fn;
  },
}));

import { useCtrlKey } from "../useCtrlKey";

// ── Helpers ─────────────────────────────────────────────────────────────

function dispatch(event: string, detail?: Partial<KeyboardEvent>) {
  const handlers = listeners.get(event) ?? [];
  for (const h of handlers) h(detail ?? {});
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("useCtrlKey", () => {
  let cleanup: (() => void) | void;

  beforeEach(() => {
    listeners = new Map();
    fakeWindow.addEventListener.mockClear();
    fakeWindow.removeEventListener.mockClear();
    stateValue = false;
    lastEffect = null;
    cleanup = undefined;
  });

  afterEach(() => {
    if (typeof cleanup === "function") cleanup();
    vi.restoreAllMocks();
  });

  function mount() {
    const result = useCtrlKey();
    expect(lastEffect).not.toBeNull();
    cleanup = lastEffect!();
    return result;
  }

  it("returns false initially", () => {
    const held = mount();
    expect(held).toBe(false);
  });

  it("registers keydown, keyup, and blur listeners", () => {
    mount();
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith("keyup", expect.any(Function));
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(fakeWindow.addEventListener).toHaveBeenCalledTimes(3);
  });

  it("sets held=true on Control keydown", () => {
    mount();
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
  });

  it("sets held=false on Control keyup", () => {
    mount();
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
    dispatch("keyup", { key: "Control" });
    expect(stateValue).toBe(false);
  });

  it("ignores non-Control keys on keydown", () => {
    mount();
    dispatch("keydown", { key: "Shift" });
    expect(stateValue).toBe(false);
    dispatch("keydown", { key: "a" });
    expect(stateValue).toBe(false);
    dispatch("keydown", { key: "Meta" });
    expect(stateValue).toBe(false);
    dispatch("keydown", { key: "Alt" });
    expect(stateValue).toBe(false);
  });

  it("ignores non-Control keys on keyup", () => {
    mount();
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
    dispatch("keyup", { key: "Shift" });
    expect(stateValue).toBe(true);
    dispatch("keyup", { key: "a" });
    expect(stateValue).toBe(true);
  });

  it("resets to false on window blur", () => {
    mount();
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
    dispatch("blur");
    expect(stateValue).toBe(false);
  });

  it("handles rapid keydown/keyup toggling", () => {
    mount();
    for (let i = 0; i < 10; i++) {
      dispatch("keydown", { key: "Control" });
      expect(stateValue).toBe(true);
      dispatch("keyup", { key: "Control" });
      expect(stateValue).toBe(false);
    }
  });

  it("stays true on repeated keydown without keyup (key repeat)", () => {
    mount();
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
  });

  it("blur when already false is a no-op", () => {
    mount();
    expect(stateValue).toBe(false);
    dispatch("blur");
    expect(stateValue).toBe(false);
  });

  it("cleanup removes all three listeners", () => {
    mount();
    expect(listeners.get("keydown")?.length).toBe(1);
    expect(listeners.get("keyup")?.length).toBe(1);
    expect(listeners.get("blur")?.length).toBe(1);

    if (typeof cleanup === "function") cleanup();
    cleanup = undefined;

    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith("keyup", expect.any(Function));
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(3);

    expect(listeners.get("keydown")?.length).toBe(0);
    expect(listeners.get("keyup")?.length).toBe(0);
    expect(listeners.get("blur")?.length).toBe(0);
  });

  it("events after cleanup have no effect", () => {
    mount();
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);

    if (typeof cleanup === "function") cleanup();
    cleanup = undefined;

    // Handlers removed — dispatch reaches no listeners
    stateValue = true;
    dispatch("blur");
    expect(stateValue).toBe(true);
    dispatch("keyup", { key: "Control" });
    expect(stateValue).toBe(true);
  });

  it("Control keydown after blur re-enables held", () => {
    mount();
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
    dispatch("blur");
    expect(stateValue).toBe(false);
    dispatch("keydown", { key: "Control" });
    expect(stateValue).toBe(true);
  });
});
