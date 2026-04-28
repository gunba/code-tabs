import { describe, it, expect } from "vitest";
import { vehicleFor } from "../Vehicle";

describe("vehicleFor", () => {
  it("is stable for the same id (no surprise re-rolls between renders)", () => {
    const id = "session-abc-123";
    expect(vehicleFor(id)).toBe(vehicleFor(id));
  });

  it("returns one of the three vehicles", () => {
    const ids = ["a", "b", "c", "d", "session-1", "session-2", "alpha-bravo"];
    for (const id of ids) {
      const v = vehicleFor(id);
      expect(["board", "jetski", "swim"]).toContain(v);
    }
  });

  it("distributes across all three buckets over enough ids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(vehicleFor(`id-${i}`));
    }
    expect(seen).toContain("board");
    expect(seen).toContain("jetski");
    expect(seen).toContain("swim");
  });

  it("is deterministic across runs (no Math.random sneak in)", () => {
    expect(vehicleFor("hello")).toBe(vehicleFor("hello"));
    expect(vehicleFor("world")).toBe(vehicleFor("world"));
  });
});
