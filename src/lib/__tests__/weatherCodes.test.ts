import { describe, it, expect } from "vitest";
import { sceneForCode } from "../weatherCodes";

describe("sceneForCode", () => {
  it("treats null and undefined as clear (renderer falls back to sun)", () => {
    expect(sceneForCode(null)).toBe("clear");
    expect(sceneForCode(undefined)).toBe("clear");
  });

  it("0 is clear", () => {
    expect(sceneForCode(0)).toBe("clear");
  });

  it("1-3 are cloud variants (mainly clear / partly / overcast)", () => {
    expect(sceneForCode(1)).toBe("clouds");
    expect(sceneForCode(2)).toBe("clouds");
    expect(sceneForCode(3)).toBe("clouds");
  });

  it("45 / 48 are fog", () => {
    expect(sceneForCode(45)).toBe("fog");
    expect(sceneForCode(48)).toBe("fog");
  });

  it("drizzle / rain WMO codes map to rain", () => {
    expect(sceneForCode(51)).toBe("rain");
    expect(sceneForCode(63)).toBe("rain");
    expect(sceneForCode(80)).toBe("rain");
  });

  it("snow / snow showers", () => {
    expect(sceneForCode(71)).toBe("snow");
    expect(sceneForCode(75)).toBe("snow");
  });

  it("thunderstorm codes 95-99 map to storm", () => {
    expect(sceneForCode(95)).toBe("storm");
    expect(sceneForCode(99)).toBe("storm");
  });

  it("anything outside the documented buckets falls back to clear", () => {
    expect(sceneForCode(7)).toBe("clear");
    expect(sceneForCode(40)).toBe("clear");
  });
});
