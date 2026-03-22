import { describe, it, expect } from "vitest";
import { highlightJson, insertIntoJson } from "../../components/ConfigManager/SettingsPane";

describe("highlightJson", () => {
  it("wraps object keys in sh-key spans", () => {
    const result = highlightJson('"name": "value"');
    expect(result).toContain('<span class="sh-key">"name"</span>:');
  });

  it("wraps string values after colon in sh-string spans", () => {
    const result = highlightJson('"key": "hello"');
    expect(result).toContain('<span class="sh-string">"hello"</span>');
  });

  it("wraps numbers in sh-number spans", () => {
    const result = highlightJson('"count": 42');
    expect(result).toContain('<span class="sh-number">42</span>');
  });

  it("wraps floating point numbers", () => {
    const result = highlightJson('"price": 9.99');
    expect(result).toContain('<span class="sh-number">9.99</span>');
  });

  it("wraps scientific notation numbers", () => {
    const result = highlightJson('"big": 1e10');
    expect(result).toContain('<span class="sh-number">1e10</span>');
  });

  it("wraps true/false/null in sh-bool spans", () => {
    const resultTrue = highlightJson('"a": true');
    expect(resultTrue).toContain('<span class="sh-bool">true</span>');

    const resultFalse = highlightJson('"b": false');
    expect(resultFalse).toContain('<span class="sh-bool">false</span>');

    const resultNull = highlightJson('"c": null');
    expect(resultNull).toContain('<span class="sh-bool">null</span>');
  });

  it("escapes HTML entities in input", () => {
    const result = highlightJson('"key": "<script>"');
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes ampersands", () => {
    const result = highlightJson('"key": "a&b"');
    expect(result).toContain("a&amp;b");
  });

  it("handles empty string input", () => {
    const result = highlightJson("");
    expect(result).toBe("");
  });

  it("handles full JSON object", () => {
    const input = JSON.stringify({ name: "test", count: 5, active: true }, null, 2);
    const result = highlightJson(input);
    expect(result).toContain('<span class="sh-key">"name"</span>:');
    expect(result).toContain('<span class="sh-key">"count"</span>:');
    expect(result).toContain('<span class="sh-key">"active"</span>:');
    expect(result).toContain('<span class="sh-string">"test"</span>');
    expect(result).toContain('<span class="sh-number">5</span>');
    expect(result).toContain('<span class="sh-bool">true</span>');
  });

  it("highlights standalone strings in arrays", () => {
    const input = '["alpha", "beta"]';
    const result = highlightJson(input);
    expect(result).toContain('<span class="sh-string">"alpha"</span>');
    expect(result).toContain('<span class="sh-string">"beta"</span>');
  });

  it("handles keys with escaped quotes", () => {
    const result = highlightJson('"key\\"name": "val"');
    expect(result).toContain('<span class="sh-key">"key\\"name"</span>:');
  });

  it("handles string values with escaped characters", () => {
    const result = highlightJson('"k": "line\\nbreak"');
    expect(result).toContain('<span class="sh-string">"line\\nbreak"</span>');
  });

  it("does not double-wrap keys as strings", () => {
    const result = highlightJson('"name": "value"');
    // The key should be sh-key, not sh-string
    const keyMatches = result.match(/sh-key/g);
    const stringMatches = result.match(/sh-string/g);
    expect(keyMatches).toHaveLength(1);
    expect(stringMatches).toHaveLength(1);
  });

  it("handles nested objects", () => {
    const input = JSON.stringify({ outer: { inner: 1 } }, null, 2);
    const result = highlightJson(input);
    expect(result).toContain('<span class="sh-key">"outer"</span>:');
    expect(result).toContain('<span class="sh-key">"inner"</span>:');
    expect(result).toContain('<span class="sh-number">1</span>');
  });
});

describe("insertIntoJson", () => {
  it("creates new object from empty string", () => {
    const result = insertIntoJson("", "model", "claude-3");
    expect(JSON.parse(result)).toEqual({ model: "claude-3" });
  });

  it("creates new object from empty braces", () => {
    const result = insertIntoJson("{}", "verbose", true);
    expect(JSON.parse(result)).toEqual({ verbose: true });
  });

  it("creates new object from whitespace-only string", () => {
    const result = insertIntoJson("   ", "key", "val");
    expect(JSON.parse(result)).toEqual({ key: "val" });
  });

  it("inserts into valid existing JSON", () => {
    const existing = JSON.stringify({ model: "claude-3" }, null, 2);
    const result = insertIntoJson(existing, "verbose", true);
    const parsed = JSON.parse(result);
    expect(parsed.model).toBe("claude-3");
    expect(parsed.verbose).toBe(true);
  });

  it("overwrites existing key in valid JSON", () => {
    const existing = JSON.stringify({ model: "old" }, null, 2);
    const result = insertIntoJson(existing, "model", "new");
    expect(JSON.parse(result)).toEqual({ model: "new" });
  });

  it("inserts array values", () => {
    const result = insertIntoJson("{}", "tools", ["read", "write"]);
    expect(JSON.parse(result)).toEqual({ tools: ["read", "write"] });
  });

  it("inserts object values", () => {
    const result = insertIntoJson("{}", "env", { PATH: "/usr/bin" });
    expect(JSON.parse(result)).toEqual({ env: { PATH: "/usr/bin" } });
  });

  it("inserts numeric values", () => {
    const result = insertIntoJson("{}", "maxBudget", 50);
    expect(JSON.parse(result)).toEqual({ maxBudget: 50 });
  });

  it("handles invalid JSON by appending before last brace", () => {
    const invalid = '{\n  "model": "claude-3",\n  BROKEN\n}';
    const result = insertIntoJson(invalid, "verbose", true);
    expect(result).toContain('"verbose"');
    expect(result).toContain("true");
    expect(result.endsWith("\n}")).toBe(true);
  });

  it("adds comma for invalid JSON with existing content", () => {
    const invalid = '{\n  "model": "claude-3"\n  BAD\n}';
    const result = insertIntoJson(invalid, "key", "val");
    // Should add a comma before the new entry
    expect(result).toContain(",");
    expect(result).toContain('"key"');
  });

  it("returns input unchanged for invalid JSON without closing brace", () => {
    const noBrace = '"just a string';
    const result = insertIntoJson(noBrace, "key", "val");
    expect(result).toBe(noBrace);
  });

  it("handles whitespace around valid JSON", () => {
    const padded = "  \n  {} \n  ";
    const result = insertIntoJson(padded, "key", "val");
    expect(JSON.parse(result)).toEqual({ key: "val" });
  });
});
