import { describe, it, expect } from "vitest";
import {
  parseCodexJsonSchema,
  buildCodexSettingsSchema,
  defaultForCodexType,
  groupCodexByCategory,
  getCodexUnknownKeys,
  getCodexTypeMismatches,
} from "../codexSchema";
import type { JsonSchema, SettingField } from "../settingsSchema";

const MINI_SCHEMA: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  properties: {
    model: {
      type: "string",
      description: "Active model slug (e.g. gpt-5).",
    },
    sandbox_mode: {
      type: "string",
      enum: ["disabled", "workspace-write", "danger-full-access"],
      description: "Sandbox mode for shell tool calls.",
    },
    shell_environment_policy: {
      type: "object",
      description: "How env vars are forwarded to subprocesses.",
      properties: {
        inherit: {
          type: "string",
          enum: ["all", "core", "none"],
          description: "Inheritance strategy.",
        },
        ignore_default_excludes: {
          type: "boolean",
          description: "Skip the default *KEY* / *SECRET* / *TOKEN* exclude.",
        },
      },
    },
    mcp_servers: {
      type: "object",
      description: "MCP servers (user-keyed).",
      additionalProperties: { type: "object" },
    },
  },
};

describe("parseCodexJsonSchema", () => {
  it("emits scalar top-level fields with type, description, and category", () => {
    const fields = parseCodexJsonSchema(MINI_SCHEMA);
    const model = fields.find((f) => f.key === "model");
    expect(model).toMatchObject({ type: "string", category: "model" });
    expect(model!.description).toContain("model slug");
  });

  it("collapses enums to choices", () => {
    const fields = parseCodexJsonSchema(MINI_SCHEMA);
    const sandbox = fields.find((f) => f.key === "sandbox_mode")!;
    expect(sandbox.type).toBe("enum");
    expect(sandbox.choices).toEqual(["disabled", "workspace-write", "danger-full-access"]);
    expect(sandbox.category).toBe("sandbox");
  });

  it("flattens typed-object tables one level deep", () => {
    const fields = parseCodexJsonSchema(MINI_SCHEMA);
    const inherit = fields.find((f) => f.key === "shell_environment_policy.inherit");
    expect(inherit).toBeDefined();
    expect(inherit!.type).toBe("enum");
    expect(inherit!.category).toBe("shell-env");
    const ignoreDefault = fields.find((f) => f.key === "shell_environment_policy.ignore_default_excludes");
    expect(ignoreDefault!.type).toBe("boolean");
  });

  it("emits managed-elsewhere stub for additionalProperties tables", () => {
    const fields = parseCodexJsonSchema(MINI_SCHEMA);
    const mcp = fields.find((f) => f.key === "mcp_servers")!;
    expect(mcp.category).toBe("managed-elsewhere");
    expect(mcp.description).toContain("MCP Servers");
  });
});

describe("defaultForCodexType", () => {
  it("returns first choice for enum fields", () => {
    expect(
      defaultForCodexType({ type: "enum", choices: ["a", "b"], key: "x", label: "X", description: "", category: "advanced", scopes: ["user"] }),
    ).toBe("a");
  });
  it("returns true for boolean (opt-in change semantics)", () => {
    expect(
      defaultForCodexType({ type: "boolean", key: "x", label: "X", description: "", category: "advanced", scopes: ["user"] }),
    ).toBe(true);
  });
  it("returns 0 for number, '' for string, [] for array, {} for object/stringMap", () => {
    expect(defaultForCodexType({ type: "number" } as SettingField)).toBe(0);
    expect(defaultForCodexType({ type: "string" } as SettingField)).toBe("");
    expect(defaultForCodexType({ type: "stringArray" } as SettingField)).toEqual([]);
    expect(defaultForCodexType({ type: "stringMap" } as SettingField)).toEqual({});
    expect(defaultForCodexType({ type: "object" } as SettingField)).toEqual({});
  });
});

describe("buildCodexSettingsSchema", () => {
  it("returns empty when no schema", () => {
    expect(buildCodexSettingsSchema(null)).toEqual([]);
  });
  it("delegates to parseCodexJsonSchema", () => {
    const fields = buildCodexSettingsSchema(MINI_SCHEMA);
    expect(fields.length).toBeGreaterThan(0);
  });
});

describe("groupCodexByCategory", () => {
  it("groups in canonical order; empty buckets dropped", () => {
    const fields = parseCodexJsonSchema(MINI_SCHEMA);
    const grouped = groupCodexByCategory(fields);
    const keys = Array.from(grouped.keys());
    // model bucket comes before shell-env in canonical order.
    expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("shell-env"));
    // managed-elsewhere ends up at the end (mcp_servers).
    expect(keys[keys.length - 1]).toBe("managed-elsewhere");
  });
});

describe("getCodexUnknownKeys", () => {
  it("accepts dotted paths under known top-level tables", () => {
    const schema = parseCodexJsonSchema(MINI_SCHEMA);
    const known = new Set([
      "model",
      "shell_environment_policy",
      "shell_environment_policy.inherit",
      "shell_environment_policy.set", // deeper nesting under known table
      "shell_environment_policy.set.OPENAI_API_KEY",
    ]);
    expect(getCodexUnknownKeys(known, schema)).toEqual([]);
  });
  it("flags unknown top-level keys", () => {
    const schema = parseCodexJsonSchema(MINI_SCHEMA);
    const unknown = getCodexUnknownKeys(new Set(["model", "totally_made_up"]), schema);
    expect(unknown).toEqual(["totally_made_up"]);
  });
  it("accepts user-keyed children of additionalProperties tables", () => {
    const schema = parseCodexJsonSchema(MINI_SCHEMA);
    const known = new Set(["mcp_servers", "mcp_servers.docs", "mcp_servers.docs.command"]);
    expect(getCodexUnknownKeys(known, schema)).toEqual([]);
  });
});

describe("getCodexTypeMismatches", () => {
  it("flags wrong types for nested leaves", () => {
    const schema = parseCodexJsonSchema(MINI_SCHEMA);
    const mismatches = getCodexTypeMismatches(
      {
        model: 42, // number, expected string
        shell_environment_policy: {
          inherit: "core",
          ignore_default_excludes: "yes", // string, expected boolean
        },
      },
      schema,
    );
    expect(mismatches).toContainEqual({ key: "model", expected: "string", actual: "number" });
    expect(mismatches).toContainEqual({
      key: "shell_environment_policy.ignore_default_excludes",
      expected: "boolean",
      actual: "string",
    });
  });
  it("ignores values whose key isn't in the schema", () => {
    const schema = parseCodexJsonSchema(MINI_SCHEMA);
    const mismatches = getCodexTypeMismatches({ totally_made_up: 42 }, schema);
    expect(mismatches).toEqual([]);
  });
});
