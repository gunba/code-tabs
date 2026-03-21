import { describe, it, expect } from "vitest";
import { buildSettingsSchema, getUnknownKeys, groupByCategory } from "../settingsSchema";
import type { CliOption } from "../../store/settings";

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
});
