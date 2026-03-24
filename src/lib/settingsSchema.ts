/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CliOption } from "../store/settings";

export type Scope = "user" | "project" | "project-local";

export type ClaudeMdType = "claudemd-root" | "claudemd-dotclaude" | "claudemd-user";

export interface AgentFile {
  name: string;
  path: string;
}

export interface StatusMessage {
  text: string;
  type: "success" | "error";
}

export interface SettingField {
  key: string;
  label: string;
  type: "boolean" | "string" | "number" | "enum" | "stringArray" | "stringMap" | "object";
  description: string;
  choices?: string[];
  category: string;
  scopes: Scope[];
}

/** Binary-discovered setting from Zod schema scan */
export interface BinarySettingField {
  key: string;
  type: string;
  description: string;
  optional?: boolean;
  choices?: string[];
}

// Flags that map to different settings keys than their camelCase conversion
const FLAG_TO_KEY: Record<string, string> = {
  "--effort": "effortLevel",
  "--permission-mode": "permissionMode",
  "--max-budget-usd": "maxBudget",
  "--add-dir": "additionalDirs",
};

// Flags that are session-only (not persisted as settings)
const SESSION_ONLY = new Set([
  "--resume", "--continue", "--session-id", "--fork-session", "--version",
  "--help", "--print", "--output-format", "--input-format", "--from-pr",
  "--init", "--project-dir", "--run", "--input-file",
]);

// Valid SettingField type values for validating binary-discovered fields
const VALID_FIELD_TYPES = new Set<string>(["boolean", "string", "number", "enum", "stringArray", "stringMap", "object"]);

// Static settings that have no CLI flag and won't be in the binary scan
const STATIC_FIELDS: SettingField[] = [
  { key: "env", label: "Environment Variables", type: "stringMap", description: "Environment variables passed to Claude", category: "environment", scopes: ["user", "project", "project-local"] },
  { key: "permissions", label: "Permissions", type: "object", description: "Permission rules with allow/deny arrays of tool patterns", category: "permissions", scopes: ["user", "project", "project-local"] },
  { key: "hooks", label: "Hooks", type: "object", description: "Event hooks configuration", category: "hooks", scopes: ["user", "project", "project-local"] },
];

/** JSON Schema types from schemastore */
export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: string[];
  anyOf?: JsonSchemaProperty[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: JsonSchemaProperty | boolean;
  default?: any;
  const?: any;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  $schema?: string;
  description?: string;
}

/** Unwrap anyOf wrappers (Zod optionals produce anyOf:[{type:X},{type:'null'}]) */
function unwrapAnyOf(prop: JsonSchemaProperty): JsonSchemaProperty {
  if (prop.anyOf) {
    // Filter out null type entries
    const nonNull = prop.anyOf.filter(
      (v) => v.type !== "null" && v.const !== null
    );
    if (nonNull.length === 1) {
      // Merge description from parent
      return { ...nonNull[0], description: nonNull[0].description ?? prop.description };
    }
    // Multiple non-null: check if it's an enum pattern (all have const)
    if (nonNull.every((v) => v.const !== undefined)) {
      return {
        type: "string",
        enum: nonNull.map((v) => String(v.const)),
        description: prop.description,
      };
    }
  }
  return prop;
}

/** Map a JSON Schema property to our SettingField type */
function jsonSchemaToFieldType(prop: JsonSchemaProperty): { type: SettingField["type"]; choices?: string[] } {
  const unwrapped = unwrapAnyOf(prop);

  if (unwrapped.enum) {
    return { type: "enum", choices: unwrapped.enum };
  }

  const t = Array.isArray(unwrapped.type) ? unwrapped.type[0] : unwrapped.type;
  switch (t) {
    case "boolean": return { type: "boolean" };
    case "number":
    case "integer": return { type: "number" };
    case "array": return { type: "stringArray" };
    case "object": {
      // object with additionalProperties of string → stringMap
      if (unwrapped.additionalProperties && typeof unwrapped.additionalProperties === "object"
        && unwrapped.additionalProperties.type === "string") {
        return { type: "stringMap" };
      }
      return { type: "object" };
    }
    default: return { type: "string" };
  }
}

/** Parse a JSON Schema (from schemastore) into SettingField[] */
export function parseJsonSchema(schema: JsonSchema): SettingField[] {
  if (!schema.properties) return [];
  const fields: SettingField[] = [];

  for (const [key, rawProp] of Object.entries(schema.properties)) {
    const prop = unwrapAnyOf(rawProp);
    const description = prop.description ?? rawProp.description ?? "";
    const { type, choices } = jsonSchemaToFieldType(rawProp);

    fields.push({
      key,
      label: keyToLabel(key),
      type,
      description,
      choices,
      category: categorize(key, description),
      scopes: ["user", "project", "project-local"],
    });
  }

  return fields;
}

/** Get default value for a setting type */
export function defaultForType(field: SettingField): any {
  if (field.choices && field.choices.length > 0) return field.choices[0];
  switch (field.type) {
    case "boolean": return false;
    case "string": return "";
    case "number": return 0;
    case "stringArray": return [];
    case "stringMap": return {};
    case "object": return {};
    case "enum": return "";
    default: return "";
  }
}

/** Convert --kebab-flag to camelCase key */
function flagToKey(flag: string): string {
  if (FLAG_TO_KEY[flag]) return FLAG_TO_KEY[flag];
  return flag
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Infer field type from CLI option */
function inferType(opt: CliOption): { type: SettingField["type"]; choices?: string[] } {
  if (!opt.argName) return { type: "boolean" };

  const choicesMatch = opt.description.match(/\(choices:\s*(.+?)\)/);
  if (choicesMatch) {
    const choices = choicesMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/['"]/g, ""))
      .filter(Boolean);
    if (choices.length > 0) return { type: "enum", choices };
  }

  if (opt.argName.includes("...")) return { type: "stringArray" };
  if (/amount|usd|budget|number|count/i.test(opt.argName + opt.description)) return { type: "number" };

  return { type: "string" };
}

/** Categorize a setting key */
function categorize(key: string, description: string): string {
  if (/permission|allow|deny|dangerous|skip.*prompt/i.test(key + description)) return "permissions";
  if (/tool/i.test(key) && /allow|disallow/i.test(key)) return "permissions";
  if (/mcp|plugin|server/i.test(key)) return "plugins";
  if (/hook/i.test(key)) return "hooks";
  if (/env/i.test(key) && /variable|environment/i.test(description)) return "environment";
  if (/model|effort|verbose|debug|budget|prompt|agent|fast|voice|view|motion|memory|update/i.test(key)) return "general";
  return "advanced";
}

/** Convert camelCase key to human-readable label */
function keyToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/**
 * Build settings schema from four sources (in priority order):
 * 1. JSON Schema from schemastore (most complete — all keys, types, descriptions)
 * 2. CLI --help options (reliable for flag-settable keys)
 * 3. Binary Zod schema scan (discovers settings-only keys)
 * 4. Static registry (fallback for keys missed by all)
 */
export function buildSettingsSchema(
  cliOptions: CliOption[],
  binaryFields?: BinarySettingField[],
  jsonSchema?: JsonSchema | null,
): SettingField[] {
  const fields: SettingField[] = [];
  const seenKeys = new Set<string>();

  // 1. JSON Schema fields (highest priority — authoritative from schemastore)
  if (jsonSchema) {
    for (const field of parseJsonSchema(jsonSchema)) {
      if (!seenKeys.has(field.key)) {
        seenKeys.add(field.key);
        fields.push(field);
      }
    }
  }

  // 2. CLI flag-derived fields (fills in anything schema missed)
  for (const opt of cliOptions) {
    if (SESSION_ONLY.has(opt.flag)) continue;

    const key = flagToKey(opt.flag);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const { type, choices } = inferType(opt);
    fields.push({
      key,
      label: keyToLabel(key),
      type,
      description: opt.description,
      choices,
      category: categorize(key, opt.description),
      scopes: ["user", "project", "project-local"],
    });
  }

  // 3. Binary-discovered fields (settings-only keys not exposed via CLI flags)
  if (binaryFields) {
    for (const bf of binaryFields) {
      if (seenKeys.has(bf.key)) continue;
      seenKeys.add(bf.key);

      const fieldType = VALID_FIELD_TYPES.has(bf.type)
        ? bf.type as SettingField["type"]
        : "string";

      fields.push({
        key: bf.key,
        label: keyToLabel(bf.key),
        type: fieldType,
        description: bf.description,
        choices: bf.choices,
        category: categorize(bf.key, bf.description),
        scopes: ["user", "project", "project-local"],
      });
    }
  }

  // 4. Static fields (fallback for structural keys)
  for (const field of STATIC_FIELDS) {
    if (!seenKeys.has(field.key)) {
      seenKeys.add(field.key);
      fields.push(field);
    }
  }

  return fields;
}

/** Check for type mismatches between JSON values and schema */
export function getTypeMismatches(
  json: Record<string, unknown>,
  schema: SettingField[],
): { key: string; expected: string; actual: string }[] {
  const fieldMap = new Map(schema.map((f) => [f.key, f]));
  const mismatches: { key: string; expected: string; actual: string }[] = [];

  for (const [key, value] of Object.entries(json)) {
    const field = fieldMap.get(key);
    if (!field || value === null || value === undefined) continue;

    const actual = Array.isArray(value) ? "array" : typeof value;
    let ok = false;
    switch (field.type) {
      case "boolean": ok = actual === "boolean"; break;
      case "number": ok = actual === "number"; break;
      case "string":
      case "enum": ok = actual === "string"; break;
      case "stringArray": ok = actual === "array"; break;
      case "stringMap":
      case "object": ok = actual === "object"; break;
    }
    if (!ok) {
      mismatches.push({ key, expected: field.type, actual });
    }
  }
  return mismatches;
}

/** Get unknown keys from JSON that aren't in the schema */
export function getUnknownKeys(json: Record<string, unknown>, schema: SettingField[]): string[] {
  const known = new Set(schema.map((f) => f.key));
  return Object.keys(json).filter((k) => !known.has(k));
}

/** Which schema sources contributed fields */
export interface SchemaSourceInfo {
  hasSchemaStore: boolean;
  hasCli: boolean;
  hasBinary: boolean;
}

/** Report which schema sources are available */
export function getSchemaSourceInfo(
  cliOptions: CliOption[],
  binaryFields?: BinarySettingField[],
  jsonSchema?: JsonSchema | null,
): SchemaSourceInfo {
  return {
    hasSchemaStore: !!jsonSchema?.properties && Object.keys(jsonSchema.properties).length > 0,
    hasCli: cliOptions.length > 0,
    hasBinary: !!binaryFields && binaryFields.length > 0,
  };
}

/** Truncate a list to `max` items, appending "+N more" if needed */
export function summarizeList(items: string[], max = 3): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

/** Group fields by category */
export function groupByCategory(fields: SettingField[]): Map<string, SettingField[]> {
  const groups = new Map<string, SettingField[]>();
  const order = ["general", "permissions", "environment", "plugins", "hooks", "advanced"];
  for (const cat of order) groups.set(cat, []);
  for (const field of fields) {
    const arr = groups.get(field.category) || [];
    arr.push(field);
    groups.set(field.category, arr);
  }
  for (const [k, v] of groups) {
    if (v.length === 0) groups.delete(k);
  }
  return groups;
}
