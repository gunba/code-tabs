import { describe, it, expect } from "vitest";
import { parseToml, flattenTomlKeys } from "../tomlParse";

describe("parseToml", () => {
  it("returns an empty table for blank input", () => {
    const result = parseToml("");
    expect(result).toEqual({ ok: true, value: {} });
  });
  it("parses scalars and tables", () => {
    const result = parseToml(`model = "gpt-5"\nsandbox_mode = "workspace-write"\n[shell_environment_policy]\ninherit = "core"\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      model: "gpt-5",
      sandbox_mode: "workspace-write",
      shell_environment_policy: { inherit: "core" },
    });
  });
  it("returns an error result for malformed input", () => {
    const result = parseToml(`model = `);
    expect(result.ok).toBe(false);
  });
});

describe("flattenTomlKeys", () => {
  it("emits parent paths and dotted leaves", () => {
    const result = parseToml(`model = "gpt-5"\n[shell_environment_policy]\ninherit = "core"\nignore_default_excludes = true\n[mcp_servers.docs]\ncommand = "docs-server"\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = flattenTomlKeys(result.value);
    expect(keys.has("model")).toBe(true);
    expect(keys.has("shell_environment_policy")).toBe(true);
    expect(keys.has("shell_environment_policy.inherit")).toBe(true);
    expect(keys.has("shell_environment_policy.ignore_default_excludes")).toBe(true);
    expect(keys.has("mcp_servers")).toBe(true);
    expect(keys.has("mcp_servers.docs")).toBe(true);
    expect(keys.has("mcp_servers.docs.command")).toBe(true);
  });
  it("does not descend into arrays", () => {
    const result = parseToml(`[[arr]]\nkey = 1\n[[arr]]\nkey = 2\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = flattenTomlKeys(result.value);
    expect(keys.has("arr")).toBe(true);
    expect(keys.has("arr.key")).toBe(false);
  });
});
