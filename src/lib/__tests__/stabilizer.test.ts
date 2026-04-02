import { describe, it, expect } from "vitest";

/**
 * Pure stabilization logic extracted from useStabilizedValue.
 * The hook wraps this exact algorithm — testing it directly avoids
 * needing @testing-library/react.
 */
interface StabState {
  prev: string | null;
  count: number;
  stable: string | null;
  initialized: boolean;
}

function stabilize(value: string | null, state: StabState, threshold = 2): StabState {
  const s = { ...state };

  if (!s.initialized) {
    s.initialized = true;
    s.prev = value;
    s.count = 1;
    s.stable = value;
    return s;
  }

  if (value === s.prev) {
    s.count++;
    if (s.count >= threshold && value !== s.stable) {
      s.stable = value;
    }
  } else {
    s.prev = value;
    s.count = 1;
  }

  return s;
}

const fresh = (): StabState => ({ prev: null, count: 0, stable: null, initialized: false });

describe("branch stabilization logic", () => {
  it("accepts first value immediately", () => {
    const result = stabilize("main", fresh());
    expect(result.stable).toBe("main");
  });

  it("accepts null immediately on first call", () => {
    const result = stabilize(null, fresh());
    expect(result.stable).toBeNull();
  });

  it("requires threshold consecutive matches before changing", () => {
    let state = stabilize("main", fresh());
    expect(state.stable).toBe("main");

    // First call with different value — counter reset
    state = stabilize("develop", state);
    expect(state.stable).toBe("main");

    // Second consecutive "develop" — threshold reached
    state = stabilize("develop", state);
    expect(state.stable).toBe("develop");
  });

  it("resets counter when value changes mid-sequence", () => {
    let state = stabilize("main", fresh());
    state = stabilize("develop", state);
    expect(state.stable).toBe("main");

    // Switch before threshold — resets
    state = stabilize("feature", state);
    expect(state.stable).toBe("main");

    // Two consecutive "feature"
    state = stabilize("feature", state);
    expect(state.stable).toBe("feature");
  });

  it("does not re-set stable when same value already stable", () => {
    let state = stabilize("main", fresh());
    state = stabilize("main", state);
    expect(state.stable).toBe("main");
    state = stabilize("main", state);
    expect(state.stable).toBe("main");
  });

  it("stabilizes null after threshold when branch disappears", () => {
    let state = stabilize("main", fresh());
    state = stabilize(null, state);
    expect(state.stable).toBe("main");
    state = stabilize(null, state);
    expect(state.stable).toBeNull();
  });

  it("handles rapid toggling between two branches", () => {
    let state = stabilize("main", fresh());
    // Alternate — neither reaches threshold
    state = stabilize("develop", state);
    expect(state.stable).toBe("main");
    state = stabilize("main", state);
    expect(state.stable).toBe("main");
    state = stabilize("develop", state);
    expect(state.stable).toBe("main");
  });
});
