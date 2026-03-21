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
 * Build settings schema from three sources (in priority order):
 * 1. CLI --help options (most reliable for flag-settable keys)
 * 2. Binary Zod schema scan (discovers settings-only keys)
 * 3. Static registry (fallback for keys missed by both)
 */
export function buildSettingsSchema(
  cliOptions: CliOption[],
  binaryFields?: BinarySettingField[],
): SettingField[] {
  const fields: SettingField[] = [];
  const seenKeys = new Set<string>();

  // 1. CLI flag-derived fields (highest priority — most accurate type info)
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

  // 2. Binary-discovered fields (settings-only keys not exposed via CLI flags)
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

  // 3. Static fields (fallback for structural keys)
  for (const field of STATIC_FIELDS) {
    if (!seenKeys.has(field.key)) {
      seenKeys.add(field.key);
      fields.push(field);
    }
  }

  return fields;
}

/** Get unknown keys from JSON that aren't in the schema */
export function getUnknownKeys(json: Record<string, unknown>, schema: SettingField[]): string[] {
  const known = new Set(schema.map((f) => f.key));
  return Object.keys(json).filter((k) => !known.has(k));
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
