import { describe, it, expect } from "vitest";
import {
  buildSettingsSchema,
  getUnknownKeys,
  getTypeMismatches,
  getSchemaSourceInfo,
  summarizeList,
  groupByCategory,
  parseJsonSchema,
  defaultForType,
} from "../settingsSchema";
import type { SettingField } from "../settingsSchema";
import type { CliOption } from "../../store/settings";
import type { JsonSchema } from "../settingsSchema";

describe("buildSettingsSchema", () => {
  const sampleOptions: CliOption[] = [
    { flag: "--model", argName: "<model>", description: "Model for the current session" },
    { flag: "--verbose", description: "Enable verbose output" },
    { flag: "--effort", argName: "<level>", description: "Effort level (choices: \"low\", \"medium\", \"high\")" },
    { flag: "--max-budget-usd", argName: "<amount>", description: "Maximum budget in USD" },
    { flag: "--allowedTools", argName: "<tools...>", description: "Tools to allow" },
    { flag: "--permission-mode", argName: "<mode>", description: "Permission mode" },
    { flag: "--resume", argName: "<id>", description: "Resume a session" },
    { flag: "--add-dir", argName: "<dir>", description: "Additional directory" },
  ];

  it("creates fields from CLI options", () => {
    const fields = buildSettingsSchema(sampleOptions);
    expect(fields.length).toBeGreaterThan(0);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain("model");
    expect(keys).toContain("verbose");
    expect(keys).toContain("effortLevel"); // --effort maps to effortLevel
    expect(keys).toContain("maxBudget"); // --max-budget-usd maps to maxBudget
  });

  it("excludes session-only flags", () => {
    const fields = buildSettingsSchema(sampleOptions);
    const keys = fields.map((f) => f.key);
    expect(keys).not.toContain("resume");
  });

  it("excludes all session-only flags", () => {
    const sessionOnlyOpts: CliOption[] = [
      { flag: "--resume", argName: "<id>", description: "Resume" },
      { flag: "--continue", description: "Continue" },
      { flag: "--session-id", argName: "<id>", description: "Session ID" },
      { flag: "--fork-session", argName: "<id>", description: "Fork" },
      { flag: "--version", description: "Show version" },
      { flag: "--help", description: "Show help" },
      { flag: "--print", argName: "<msg>", description: "Print" },
      { flag: "--output-format", argName: "<fmt>", description: "Output format" },
      { flag: "--input-format", argName: "<fmt>", description: "Input format" },
      { flag: "--from-pr", argName: "<url>", description: "From PR" },
      { flag: "--init", description: "Init" },
      { flag: "--project-dir", argName: "<dir>", description: "Project dir" },
      { flag: "--run", argName: "<cmd>", description: "Run command" },
      { flag: "--input-file", argName: "<file>", description: "Input file" },
    ];
    const fields = buildSettingsSchema(sessionOnlyOpts);
    // Only static fields should remain (env, permissions, hooks)
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(["env", "permissions", "hooks"]);
  });

  it("infers boolean type for flags without argName", () => {
    const fields = buildSettingsSchema(sampleOptions);
    const verbose = fields.find((f) => f.key === "verbose");
    expect(verbose?.type).toBe("boolean");
  });

  it("infers enum type from choices pattern", () => {
    const fields = buildSettingsSchema(sampleOptions);
    const effort = fields.find((f) => f.key === "effortLevel");
    expect(effort?.type).toBe("enum");
    expect(effort?.choices).toEqual(["low", "medium", "high"]);
  });

  it("infers number type for budget args", () => {
    const fields = buildSettingsSchema(sampleOptions);
    const budget = fields.find((f) => f.key === "maxBudget");
    expect(budget?.type).toBe("number");
  });

  it("infers stringArray for variadic args", () => {
    const fields = buildSettingsSchema(sampleOptions);
    const tools = fields.find((f) => f.key === "allowedTools");
    expect(tools?.type).toBe("stringArray");
  });

  it("uses flag-to-key overrides", () => {
    const fields = buildSettingsSchema(sampleOptions);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain("permissionMode"); // --permission-mode
    expect(keys).toContain("additionalDirs"); // --add-dir
  });

  it("includes static fields", () => {
    const fields = buildSettingsSchema([]);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain("env");
    expect(keys).toContain("permissions");
    expect(keys).toContain("hooks");
  });

  it("static fields do not duplicate JSON Schema keys", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        env: { type: "object", additionalProperties: { type: "string" }, description: "From schema" },
        hooks: { type: "object", description: "From schema" },
      },
    };
    const fields = buildSettingsSchema([], [], schema);
    const envFields = fields.filter((f) => f.key === "env");
    const hooksFields = fields.filter((f) => f.key === "hooks");
    expect(envFields).toHaveLength(1);
    expect(hooksFields).toHaveLength(1);
    // Schema version wins
    expect(envFields[0].description).toBe("From schema");
  });

  it("merges binary-discovered fields without duplicating CLI fields", () => {
    const cliOpts: CliOption[] = [
      { flag: "--model", argName: "<model>", description: "Model for the current session" },
    ];
    const binaryFields = [
      { key: "model", type: "string", description: "Override default model" },
      { key: "fastMode", type: "boolean", description: "Enable fast mode" },
      { key: "autoUpdatesChannel", type: "enum", description: "Release channel", choices: ["latest", "stable"] },
    ];
    const fields = buildSettingsSchema(cliOpts, binaryFields);
    const keys = fields.map((f) => f.key);

    // CLI-derived "model" takes priority — no duplicate
    expect(keys.filter((k) => k === "model").length).toBe(1);

    // Binary-only fields are included
    expect(keys).toContain("fastMode");
    expect(keys).toContain("autoUpdatesChannel");

    // Binary field types are preserved
    const fast = fields.find((f) => f.key === "fastMode");
    expect(fast?.type).toBe("boolean");

    const channel = fields.find((f) => f.key === "autoUpdatesChannel");
    expect(channel?.type).toBe("enum");
    expect(channel?.choices).toEqual(["latest", "stable"]);
  });

  it("falls back to string for unrecognized binary field types", () => {
    const binaryFields = [
      { key: "weirdSetting", type: "unknown_type_xyz", description: "Some exotic type" },
    ];
    const fields = buildSettingsSchema([], binaryFields);
    const weird = fields.find((f) => f.key === "weirdSetting");
    expect(weird?.type).toBe("string");
  });

  it("uses JSON Schema as highest-priority tier", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        model: { type: "string", description: "Schema model description" },
        newSchemaSetting: { type: "boolean", description: "Only in schema" },
      },
    };
    const cliOpts: CliOption[] = [
      { flag: "--model", argName: "<model>", description: "CLI model description" },
    ];
    const fields = buildSettingsSchema(cliOpts, [], schema);
    const keys = fields.map((f) => f.key);

    // JSON Schema model takes priority
    const model = fields.find((f) => f.key === "model");
    expect(model?.description).toBe("Schema model description");

    // Schema-only setting is included
    expect(keys).toContain("newSchemaSetting");

    // No duplicates
    expect(keys.filter((k) => k === "model").length).toBe(1);
  });

  it("JSON Schema takes priority over binary fields too", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        fastMode: { type: "boolean", description: "From schema" },
      },
    };
    const binaryFields = [
      { key: "fastMode", type: "string", description: "From binary" },
    ];
    const fields = buildSettingsSchema([], binaryFields, schema);
    const fast = fields.find((f) => f.key === "fastMode");
    expect(fast?.type).toBe("boolean");
    expect(fast?.description).toBe("From schema");
  });

  it("converts kebab-case flags to camelCase keys", () => {
    const opts: CliOption[] = [
      { flag: "--auto-approve", description: "Auto approve" },
      { flag: "--multi-word-flag", argName: "<val>", description: "Multi word" },
    ];
    const fields = buildSettingsSchema(opts);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain("autoApprove");
    expect(keys).toContain("multiWordFlag");
  });

  it("generates labels from camelCase keys", () => {
    const fields = buildSettingsSchema([
      { flag: "--model", argName: "<model>", description: "Model" },
    ]);
    const model = fields.find((f) => f.key === "model");
    expect(model?.label).toBe("Model");

    const schema: JsonSchema = {
      type: "object",
      properties: { autoUpdatesChannel: { type: "string", description: "Channel" } },
    };
    const schemaFields = parseJsonSchema(schema);
    expect(schemaFields[0].label).toBe("Auto Updates Channel");
  });

  it("all fields have three scopes", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { model: { type: "string", description: "m" } },
    };
    const fields = buildSettingsSchema(
      [{ flag: "--verbose", description: "v" }],
      [{ key: "custom", type: "string", description: "c" }],
      schema,
    );
    for (const f of fields) {
      expect(f.scopes).toEqual(["user", "project", "project-local"]);
    }
  });
});

describe("parseJsonSchema", () => {
  it("parses basic types", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Enable verbose" },
        model: { type: "string", description: "Model name" },
        maxTokens: { type: "number", description: "Max tokens" },
        maxBudget: { type: "integer", description: "Budget cap" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields).toHaveLength(4);

    expect(fields.find((f) => f.key === "verbose")?.type).toBe("boolean");
    expect(fields.find((f) => f.key === "model")?.type).toBe("string");
    expect(fields.find((f) => f.key === "maxTokens")?.type).toBe("number");
    expect(fields.find((f) => f.key === "maxBudget")?.type).toBe("number");
  });

  it("unwraps anyOf optionals (Zod pattern)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        verbose: {
          anyOf: [
            { type: "boolean", description: "Enable verbose" },
            { type: "null" },
          ],
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe("boolean");
    expect(fields[0].description).toBe("Enable verbose");
  });

  it("inherits parent description when anyOf child has none", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        model: {
          description: "Parent description",
          anyOf: [
            { type: "string" },
            { type: "null" },
          ],
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].description).toBe("Parent description");
  });

  it("prefers child description over parent in anyOf", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        model: {
          description: "Parent desc",
          anyOf: [
            { type: "string", description: "Child desc" },
            { type: "null" },
          ],
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].description).toBe("Child desc");
  });

  it("handles anyOf with multiple non-null non-const entries (falls through to original)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        mixed: {
          description: "Mixed type",
          anyOf: [
            { type: "string" },
            { type: "number" },
          ],
        },
      },
    };
    const fields = parseJsonSchema(schema);
    // Multiple non-null, non-const: unwrapAnyOf returns original prop which has no direct type
    // jsonSchemaToFieldType will see the anyOf but unwrapAnyOf falls through, returning the original
    // Since it has no type, falls to default "string"
    expect(fields).toHaveLength(1);
    expect(fields[0].description).toBe("Mixed type");
  });

  it("handles type as an array (picks first element)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        flexible: { type: ["string", "null"] as any, description: "Flexible type" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("string");
  });

  it("anyOf with const values of null entry uses const for non-null", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        channel: {
          anyOf: [
            { const: null },
            { const: "stable" },
            { const: "preview" },
          ],
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("enum");
    expect(fields[0].choices).toEqual(["stable", "preview"]);
  });

  it("detects enum from anyOf with const values", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        effortLevel: {
          description: "Effort level",
          anyOf: [
            { const: "low" },
            { const: "medium" },
            { const: "high" },
            { type: "null" },
          ],
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe("enum");
    expect(fields[0].choices).toEqual(["low", "medium", "high"]);
  });

  it("detects enum from enum property", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        theme: { type: "string", enum: ["dark", "light", "auto"], description: "Theme" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("enum");
    expect(fields[0].choices).toEqual(["dark", "light", "auto"]);
  });

  it("maps array type to stringArray", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        allowedTools: { type: "array", items: { type: "string" }, description: "Allowed tools" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("stringArray");
  });

  it("maps object with string additionalProperties to stringMap", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Env vars",
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("stringMap");
  });

  it("maps object with boolean additionalProperties to object (not stringMap)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          additionalProperties: true,
          description: "Config",
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("object");
  });

  it("maps object with non-string additionalProperties to object", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        counts: {
          type: "object",
          additionalProperties: { type: "number" },
          description: "Counts",
        },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("object");
  });

  it("maps plain object to object type", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        permissions: { type: "object", description: "Permissions config" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].type).toBe("object");
  });

  it("returns empty array for schema without properties", () => {
    expect(parseJsonSchema({} as JsonSchema)).toEqual([]);
    expect(parseJsonSchema({ type: "object" })).toEqual([]);
  });

  it("defaults to empty description when none provided", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        bare: { type: "string" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields[0].description).toBe("");
  });

  it("categorizes fields correctly", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        model: { type: "string", description: "Model name" },
        permissions: { type: "object", description: "Permission rules" },
        env: { type: "object", description: "Environment variables", additionalProperties: { type: "string" } },
        mcpServers: { type: "object", description: "MCP server config" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields.find((f) => f.key === "model")?.category).toBe("general");
    expect(fields.find((f) => f.key === "permissions")?.category).toBe("permissions");
    expect(fields.find((f) => f.key === "env")?.category).toBe("environment");
    expect(fields.find((f) => f.key === "mcpServers")?.category).toBe("plugins");
  });

  it("categorizes hooks and advanced keys", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        hooks: { type: "object", description: "Event hooks" },
        somethingObscure: { type: "string", description: "Some obscure setting" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields.find((f) => f.key === "hooks")?.category).toBe("hooks");
    expect(fields.find((f) => f.key === "somethingObscure")?.category).toBe("advanced");
  });

  it("categorizes tool permission keys", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        allowedTools: { type: "array", description: "Tools to allow" },
        disallowedTools: { type: "array", description: "Tools to disallow" },
      },
    };
    const fields = parseJsonSchema(schema);
    expect(fields.find((f) => f.key === "allowedTools")?.category).toBe("permissions");
    expect(fields.find((f) => f.key === "disallowedTools")?.category).toBe("permissions");
  });
});

describe("defaultForType", () => {
  const makeField = (type: string, choices?: string[]): SettingField => ({
    key: "test", label: "Test", type: type as SettingField["type"], description: "",
    category: "general", scopes: ["user"],
    ...(choices ? { choices } : {}),
  });

  it("returns correct defaults for each type", () => {
    expect(defaultForType(makeField("boolean"))).toBe(false);
    expect(defaultForType(makeField("string"))).toBe("");
    expect(defaultForType(makeField("number"))).toBe(0);
    expect(defaultForType(makeField("stringArray"))).toEqual([]);
    expect(defaultForType(makeField("object"))).toEqual({});
    expect(defaultForType(makeField("enum", ["a", "b"]))).toBe("a");
  });

  it("returns {} for stringMap type", () => {
    expect(defaultForType(makeField("stringMap"))).toEqual({});
  });

  it("returns first choice for enum with choices", () => {
    expect(defaultForType(makeField("enum", ["x", "y", "z"]))).toBe("x");
  });

  it("returns empty string for enum without choices", () => {
    expect(defaultForType(makeField("enum"))).toBe("");
  });

  it("returns first choice when choices are present regardless of type", () => {
    // The choices check happens before the type switch
    expect(defaultForType(makeField("string", ["alpha", "beta"]))).toBe("alpha");
  });
});

describe("getTypeMismatches", () => {
  it("detects type mismatches", () => {
    const schema = buildSettingsSchema([
      { flag: "--verbose", description: "Enable verbose" },
      { flag: "--model", argName: "<model>", description: "Model" },
    ]);
    const json = { verbose: "not-a-bool", model: 42 };
    const mismatches = getTypeMismatches(json, schema);
    expect(mismatches.length).toBe(2);
    expect(mismatches.find((m) => m.key === "verbose")?.expected).toBe("boolean");
    expect(mismatches.find((m) => m.key === "model")?.expected).toBe("string");
  });

  it("returns empty for correct types", () => {
    const schema = buildSettingsSchema([
      { flag: "--verbose", description: "Enable verbose" },
    ]);
    const json = { verbose: true };
    expect(getTypeMismatches(json, schema)).toEqual([]);
  });

  it("ignores unknown keys", () => {
    const schema = buildSettingsSchema([]);
    const json = { unknownThing: "whatever" };
    expect(getTypeMismatches(json, schema)).toEqual([]);
  });

  it("ignores null and undefined values", () => {
    const schema = buildSettingsSchema([
      { flag: "--verbose", description: "Enable verbose" },
      { flag: "--model", argName: "<model>", description: "Model" },
    ]);
    const json = { verbose: null, model: undefined } as unknown as Record<string, unknown>;
    expect(getTypeMismatches(json, schema)).toEqual([]);
  });

  it("detects number given for enum (expects string)", () => {
    const schema: SettingField[] = [{
      key: "effortLevel", label: "Effort Level", type: "enum",
      description: "", choices: ["low", "high"], category: "general", scopes: ["user"],
    }];
    const mismatches = getTypeMismatches({ effortLevel: 42 }, schema);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toEqual({ key: "effortLevel", expected: "enum", actual: "number" });
  });

  it("detects string given for number", () => {
    const schema: SettingField[] = [{
      key: "maxBudget", label: "Max Budget", type: "number",
      description: "", category: "general", scopes: ["user"],
    }];
    const mismatches = getTypeMismatches({ maxBudget: "fifty" }, schema);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].actual).toBe("string");
  });

  it("detects string given for stringArray (expects array)", () => {
    const schema: SettingField[] = [{
      key: "tools", label: "Tools", type: "stringArray",
      description: "", category: "general", scopes: ["user"],
    }];
    const mismatches = getTypeMismatches({ tools: "not-an-array" }, schema);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toEqual({ key: "tools", expected: "stringArray", actual: "string" });
  });

  it("accepts arrays for stringArray type", () => {
    const schema: SettingField[] = [{
      key: "tools", label: "Tools", type: "stringArray",
      description: "", category: "general", scopes: ["user"],
    }];
    expect(getTypeMismatches({ tools: ["a", "b"] }, schema)).toEqual([]);
  });

  it("detects array given for stringMap (expects object)", () => {
    const schema: SettingField[] = [{
      key: "env", label: "Env", type: "stringMap",
      description: "", category: "general", scopes: ["user"],
    }];
    const mismatches = getTypeMismatches({ env: ["not", "object"] }, schema);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].actual).toBe("array");
  });

  it("accepts objects for both stringMap and object types", () => {
    const schema: SettingField[] = [
      { key: "env", label: "Env", type: "stringMap", description: "", category: "general", scopes: ["user"] },
      { key: "perms", label: "Perms", type: "object", description: "", category: "general", scopes: ["user"] },
    ];
    expect(getTypeMismatches({ env: { K: "V" }, perms: { allow: [] } }, schema)).toEqual([]);
  });
});

describe("getUnknownKeys", () => {
  it("identifies keys not in the schema", () => {
    const schema = buildSettingsSchema([]);
    const json = { env: {}, customSetting: "value", anotherUnknown: 42 };
    const unknown = getUnknownKeys(json, schema);
    expect(unknown).toContain("customSetting");
    expect(unknown).toContain("anotherUnknown");
    expect(unknown).not.toContain("env");
  });

  it("returns empty array when all keys are known", () => {
    const schema = buildSettingsSchema([
      { flag: "--model", argName: "<model>", description: "Model" },
    ]);
    const json = { model: "claude-3" };
    expect(getUnknownKeys(json, schema)).toEqual([]);
  });

  it("returns empty array for empty JSON", () => {
    const schema = buildSettingsSchema([]);
    expect(getUnknownKeys({}, schema)).toEqual([]);
  });
});

describe("groupByCategory", () => {
  it("groups fields by category and preserves order", () => {
    const fields = buildSettingsSchema([
      { flag: "--verbose", description: "Enable verbose output" },
    ]);
    const groups = groupByCategory(fields);
    const categories = Array.from(groups.keys());
    // "general" should come first if present
    if (categories.includes("general")) {
      expect(categories[0]).toBe("general");
    }
  });

  it("omits empty categories", () => {
    const groups = groupByCategory([]);
    expect(groups.size).toBe(0);
  });

  it("preserves category order: general, permissions, environment, plugins, hooks, advanced", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        somethingObscure: { type: "string", description: "Some obscure setting" },
        model: { type: "string", description: "Model" },
        allowedTools: { type: "array", description: "Tools to allow" },
        env: { type: "object", description: "Environment variables", additionalProperties: { type: "string" } },
        mcpServers: { type: "object", description: "MCP server config" },
        hooks: { type: "object", description: "Event hooks" },
      },
    };
    const fields = parseJsonSchema(schema);
    const groups = groupByCategory(fields);
    const categories = Array.from(groups.keys());
    expect(categories).toEqual(["general", "permissions", "environment", "plugins", "hooks", "advanced"]);
  });

  it("places multiple fields in same category", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        model: { type: "string", description: "Model" },
        verbose: { type: "boolean", description: "Verbose output" },
      },
    };
    const fields = parseJsonSchema(schema);
    const groups = groupByCategory(fields);
    const general = groups.get("general")!;
    expect(general.length).toBe(2);
    expect(general.map((f) => f.key)).toContain("model");
    expect(general.map((f) => f.key)).toContain("verbose");
  });
});

describe("getSchemaSourceInfo", () => {
  it("returns all false when no sources available", () => {
    expect(getSchemaSourceInfo([])).toEqual({
      hasSchemaStore: false, hasCli: false, hasBinary: false,
    });
  });

  it("returns all false for null/undefined/empty inputs", () => {
    expect(getSchemaSourceInfo([], [], null)).toEqual({
      hasSchemaStore: false, hasCli: false, hasBinary: false,
    });
  });

  it("detects schemastore when properties are present", () => {
    const info = getSchemaSourceInfo([], undefined, {
      type: "object",
      properties: { model: { type: "string" } },
    });
    expect(info.hasSchemaStore).toBe(true);
    expect(info.hasCli).toBe(false);
    expect(info.hasBinary).toBe(false);
  });

  it("returns false for schemastore with empty properties", () => {
    const info = getSchemaSourceInfo([], undefined, { type: "object", properties: {} });
    expect(info.hasSchemaStore).toBe(false);
  });

  it("detects CLI options", () => {
    const info = getSchemaSourceInfo([{ flag: "--model", description: "Model" }]);
    expect(info.hasCli).toBe(true);
  });

  it("detects binary fields", () => {
    const info = getSchemaSourceInfo([], [{ key: "model", type: "string", description: "Model" }]);
    expect(info.hasBinary).toBe(true);
  });

  it("returns all true when all sources present", () => {
    const info = getSchemaSourceInfo(
      [{ flag: "--model", description: "Model" }],
      [{ key: "verbose", type: "boolean", description: "Verbose" }],
      { type: "object", properties: { model: { type: "string" } } },
    );
    expect(info).toEqual({ hasSchemaStore: true, hasCli: true, hasBinary: true });
  });
});

describe("summarizeList", () => {
  it("returns single item", () => {
    expect(summarizeList(["foo"])).toBe("foo");
  });

  it("joins up to 3 items without overflow", () => {
    expect(summarizeList(["a", "b", "c"])).toBe("a, b, c");
  });

  it("truncates beyond 3 with +N more", () => {
    expect(summarizeList(["a", "b", "c", "d"])).toBe("a, b, c, +1 more");
  });

  it("handles 5 items", () => {
    expect(summarizeList(["a", "b", "c", "d", "e"])).toBe("a, b, c, +2 more");
  });

  it("respects custom max", () => {
    expect(summarizeList(["a", "b", "c"], 2)).toBe("a, b, +1 more");
  });
});
