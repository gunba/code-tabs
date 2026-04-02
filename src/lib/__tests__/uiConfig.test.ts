import { describe, it, expect } from "vitest";
import { deepMerge } from "../uiConfig";

describe("deepMerge", () => {
  it("returns target unchanged when source is empty", () => {
    const target = { a: 1, b: "hello" };
    const result = deepMerge(target, {});
    expect(result).toEqual({ a: 1, b: "hello" });
  });

  it("returns source values when target is empty", () => {
    const source = { a: 1, b: "hello" };
    const result = deepMerge({}, source);
    expect(result).toEqual({ a: 1, b: "hello" });
  });

  it("overwrites primitive values from source", () => {
    const target = { a: 1, b: "old" };
    const source = { a: 2, b: "new" };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 2, b: "new" });
  });

  it("preserves target keys not in source", () => {
    const target = { a: 1, b: 2, c: 3 };
    const source = { b: 20 };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 20, c: 3 });
  });

  it("adds source keys not in target", () => {
    const target = { a: 1 };
    const source = { b: 2, c: 3 };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("deeply merges nested objects", () => {
    const target = { nested: { a: 1, b: 2 } };
    const source = { nested: { b: 20, c: 30 } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ nested: { a: 1, b: 20, c: 30 } });
  });

  it("deeply merges multiple levels", () => {
    const target = { l1: { l2: { l3: { a: 1, b: 2 } } } };
    const source = { l1: { l2: { l3: { b: 20 } } } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ l1: { l2: { l3: { a: 1, b: 20 } } } });
  });

  // Arrays are treated as atomic values, not merged element-wise
  it("overwrites arrays from source instead of merging", () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4, 5] };
    const result = deepMerge(target, source);
    expect(result).toEqual({ arr: [4, 5] });
  });

  it("overwrites object with array from source", () => {
    const target = { val: { a: 1 } };
    const source = { val: [1, 2] };
    const result = deepMerge(target, source);
    expect(result).toEqual({ val: [1, 2] });
  });

  it("overwrites array with object from source", () => {
    const target = { val: [1, 2] };
    const source = { val: { a: 1 } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ val: { a: 1 } });
  });

  it("allows source to overwrite with null", () => {
    const target = { a: 1, b: { nested: true } };
    const source = { a: null, b: null };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: null, b: null });
  });

  it("allows source to overwrite with undefined", () => {
    const target = { a: 1 };
    const source = { a: undefined };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: undefined });
  });

  it("does not deep-merge when source value is null", () => {
    // null is typeof "object" but the condition checks source[key] truthiness first
    const target = { nested: { a: 1, b: 2 } };
    const source = { nested: null };
    const result = deepMerge(target, source);
    expect(result).toEqual({ nested: null });
  });

  it("does not deep-merge when target value is null", () => {
    const target = { nested: null };
    const source = { nested: { a: 1 } };
    const result = deepMerge(target as Record<string, unknown>, source);
    // target[key] is null (falsy), so source replaces entirely
    expect(result).toEqual({ nested: { a: 1 } });
  });

  it("overwrites with falsy values: 0, false, empty string", () => {
    const target = { count: 10, flag: true, name: "hello" };
    const source = { count: 0, flag: false, name: "" };
    const result = deepMerge(target, source);
    expect(result).toEqual({ count: 0, flag: false, name: "" });
  });

  it("does not mutate the target object", () => {
    const target = { a: 1, nested: { b: 2 } };
    const source = { a: 10, nested: { b: 20, c: 30 } };
    const targetCopy = JSON.parse(JSON.stringify(target));
    deepMerge(target, source);
    expect(target).toEqual(targetCopy);
  });

  it("does not mutate the source object", () => {
    const target = { nested: { a: 1 } };
    const source = { nested: { b: 2 } };
    const sourceCopy = JSON.parse(JSON.stringify(source));
    deepMerge(target, source);
    expect(source).toEqual(sourceCopy);
  });

  it("handles both target and source empty", () => {
    const result = deepMerge({}, {});
    expect(result).toEqual({});
  });

  it("overwrites primitive target value with object from source", () => {
    const target = { val: 42 };
    const source = { val: { nested: true } };
    const result = deepMerge(target as Record<string, unknown>, source);
    expect(result).toEqual({ val: { nested: true } });
  });

  it("overwrites object target value with primitive from source", () => {
    const target = { val: { nested: true } };
    const source = { val: 42 };
    const result = deepMerge(target, source);
    expect(result).toEqual({ val: 42 });
  });

  it("handles realistic UiConfig merge scenario", () => {
    const defaults = {
      version: 2,
      deadSessions: { maxAge: 7 },
      resume: { maxItems: 12, showSize: true, showRelativeDate: true },
    };
    // User overrides only resume.maxItems
    const userConfig = {
      version: 2,
      resume: { maxItems: 50 },
    };
    const result = deepMerge(defaults, userConfig);
    expect(result).toEqual({
      version: 2,
      deadSessions: { maxAge: 7 },
      resume: { maxItems: 50, showSize: true, showRelativeDate: true },
    });
  });

  it("handles config with extra unknown keys from user", () => {
    const defaults = { version: 1, settings: { theme: "dark" } };
    const userConfig = { version: 1, settings: { theme: "light" }, extraKey: "bonus" };
    const result = deepMerge(defaults, userConfig);
    expect(result).toEqual({
      version: 1,
      settings: { theme: "light" },
      extraKey: "bonus",
    });
  });
});
