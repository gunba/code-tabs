/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Codex JSON Schema → flattened SettingField[] for the Settings reference panel.
 *
 * Reuses the SettingField shape from settingsSchema.ts so the existing
 * SettingsReference React component (categorized grid, type badges,
 * click-to-insert) renders both CLIs from the same data shape. The only
 * Codex-specific bits are:
 *
 *   1. **Path is dotted** (`shell_environment_policy.inherit`) since TOML
 *      uses dotted keys. Insert wires this through to
 *      `invoke("insert_codex_toml_key", { keyPath: ["shell_environment_policy", "inherit"], ... })`.
 *   2. **Typed-object tables are flattened.** When a top-level property's
 *      schema is `type: "object"` with explicit `properties`, we recurse and
 *      emit each child as `parent.child`. This surfaces `agents.max_depth`,
 *      `history.persistence`, `shell_environment_policy.inherit`, etc.
 *      directly in the reference panel.
 *   3. **`additionalProperties`-keyed tables (mcp_servers, profiles,
 *      plugins, model_providers, projects, marketplaces, features)** are
 *      categorized as "managed-elsewhere" with no click-to-insert. Those
 *      tables have user-chosen subkeys; the dedicated MCP / Plugins / etc.
 *      panes are the right place to edit them.
 *   4. **`$ref` resolution** walks `definitions/`. Required because most
 *      enums (SandboxMode, AskForApproval, etc.) are referenced rather than
 *      inlined.
 */

import type { JsonSchema, JsonSchemaProperty, SettingField } from "./settingsSchema";

/** Categories specific to Codex's config surface. Keeps `groupByCategory`
 * happy without polluting Claude's category set. */
export const CODEX_CATEGORY_ORDER = [
  "model",
  "sandbox",
  "approval",
  "shell-env",
  "mcp",
  "agents",
  "memories",
  "history",
  "tools",
  "ui",
  "experimental",
  "workspace",
  "notifications",
  "managed-elsewhere",
  "advanced",
] as const;

export const CODEX_CATEGORY_LABELS: Record<string, string> = {
  model: "Model",
  sandbox: "Sandbox & Permissions",
  approval: "Approvals",
  "shell-env": "Shell Environment",
  mcp: "MCP",
  agents: "Agents",
  memories: "Memories & Skills",
  history: "History & State",
  tools: "Tools",
  ui: "UI",
  experimental: "Experimental",
  workspace: "Workspace",
  notifications: "Notifications",
  "managed-elsewhere": "Managed in dedicated panes",
  advanced: "Advanced",
};

const ADDITIONAL_PROPERTIES_TABLES = new Set([
  "features",
  "marketplaces",
  "mcp_servers",
  "model_providers",
  "plugins",
  "profiles",
  "projects",
]);

/** Where the dedicated UI for an additionalProperties-keyed table lives. */
const MANAGED_ELSEWHERE_LABEL: Record<string, string> = {
  mcp_servers: "Managed in MCP Servers tab",
  plugins: "Managed in Plugins tab",
  profiles: "Profiles use the launcher's profile picker",
  model_providers: "Set via launcher provider settings",
  projects: "Per-project overrides — edit project config.toml",
  features: "Toggled by --enable/--disable flags or the features pane",
  marketplaces: "MCP server marketplaces — edit directly in TOML",
};

/** Dereference a JSON Schema `$ref` against the schema's `definitions/`. */
function resolveRef(prop: JsonSchemaProperty, root: JsonSchema): JsonSchemaProperty {
  if (!prop || typeof prop !== "object") return prop;
  const refValue = (prop as { $ref?: string }).$ref;
  if (!refValue) return prop;
  const match = refValue.match(/^#\/definitions\/(.+)$/);
  if (!match) return prop;
  const def = (root as any).definitions?.[match[1]];
  if (!def || typeof def !== "object") return prop;
  // Preserve description/default from the referencing site if any.
  return {
    ...def,
    description: prop.description ?? def.description,
    default: (prop as any).default ?? def.default,
  };
}

/** `allOf: [{$ref: "#/definitions/Foo"}]` is schemars's way of attaching
 * descriptions to a referenced type. Unwrap it. */
function unwrapAllOf(prop: JsonSchemaProperty, root: JsonSchema): JsonSchemaProperty {
  if (!prop || typeof prop !== "object") return prop;
  const allOf = (prop as { allOf?: JsonSchemaProperty[] }).allOf;
  if (!allOf || allOf.length !== 1) return prop;
  const inner = resolveRef(allOf[0], root);
  return {
    ...inner,
    description: prop.description ?? inner.description,
    default: (prop as any).default ?? (inner as any).default,
  };
}

/** Strip nullable wrappers (`anyOf: [{type: X}, {type: "null"}]`). Schemars
 * uses these for `Option<T>` fields. */
function unwrapNullableAnyOf(prop: JsonSchemaProperty): JsonSchemaProperty {
  if (!prop || typeof prop !== "object") return prop;
  const anyOf = prop.anyOf;
  if (!anyOf) return prop;
  const nonNull = anyOf.filter(
    (v) => v.type !== "null" && (v as { const?: unknown }).const !== null,
  );
  if (nonNull.length === 1) {
    return {
      ...nonNull[0],
      description: nonNull[0].description ?? prop.description,
    };
  }
  // Multi-variant enum collapsed to a list of consts.
  if (nonNull.length > 1 && nonNull.every((v) => (v as { const?: unknown }).const !== undefined)) {
    return {
      type: "string",
      enum: nonNull.map((v) => String((v as { const: unknown }).const)),
      description: prop.description,
    };
  }
  return prop;
}

function normalize(prop: JsonSchemaProperty, root: JsonSchema): JsonSchemaProperty {
  return unwrapNullableAnyOf(unwrapAllOf(resolveRef(prop, root), root));
}

function jsonSchemaToFieldType(prop: JsonSchemaProperty): {
  type: SettingField["type"];
  choices?: string[];
} {
  if (prop.enum) {
    return { type: "enum", choices: prop.enum.map((v) => String(v)) };
  }
  const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (t) {
    case "boolean":
      return { type: "boolean" };
    case "number":
    case "integer":
      return { type: "number" };
    case "array":
      return { type: "stringArray" };
    case "object": {
      if (
        prop.additionalProperties &&
        typeof prop.additionalProperties === "object" &&
        prop.additionalProperties.type === "string"
      ) {
        return { type: "stringMap" };
      }
      return { type: "object" };
    }
    default:
      return { type: "string" };
  }
}

/** Categorize a top-level Codex config key. Keeps to one bucket per key. */
function categorizeTopLevel(key: string): string {
  if (ADDITIONAL_PROPERTIES_TABLES.has(key)) return "managed-elsewhere";
  if (key === "model" || key.startsWith("model_") || key === "review_model" || key === "openai_base_url" || key === "chatgpt_base_url" || key === "oss_provider" || key === "service_tier" || key === "personality" || key === "web_search") {
    return "model";
  }
  if (key === "sandbox_mode" || key === "sandbox_workspace_write" || key === "default_permissions" || key === "permissions") {
    return "sandbox";
  }
  if (key === "approval_policy" || key === "approvals_reviewer" || key === "auto_review") {
    return "approval";
  }
  if (key === "shell_environment_policy" || key === "allow_login_shell" || key === "zsh_path") {
    return "shell-env";
  }
  if (key === "mcp_servers" || key.startsWith("mcp_oauth")) return "mcp";
  if (key === "agents") return "agents";
  if (key === "memories" || key === "skills") return "memories";
  if (key === "history" || key === "sqlite_home" || key === "log_dir" || key === "ghost_snapshot" || key === "experimental_thread_store" || key === "experimental_thread_store_endpoint" || key === "experimental_thread_config_endpoint") {
    return "history";
  }
  if (key === "tools" || key === "tool_suggest" || key === "tool_output_token_limit" || key === "experimental_use_freeform_apply_patch" || key === "experimental_use_unified_exec_tool") {
    return "tools";
  }
  if (key === "tui" || key === "audio" || key === "file_opener" || key === "disable_paste_burst" || key === "hide_agent_reasoning" || key === "show_raw_agent_reasoning") {
    return "ui";
  }
  if (key.startsWith("experimental_") || key === "realtime" || key === "otel") return "experimental";
  if (key === "project_doc_fallback_filenames" || key === "project_doc_max_bytes" || key === "project_root_markers" || key === "profile") return "workspace";
  if (key === "notice" || key === "notify" || key === "feedback" || key === "check_for_update_on_startup" || key === "suppress_unstable_features_warning") {
    return "notifications";
  }
  if (key === "plan_mode_reasoning_effort") return "agents";
  return "advanced";
}

/** Convert a snake_case TOML key into a human-readable label. */
function tomlKeyToLabel(key: string): string {
  return key
    .split(".")
    .pop()!
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Parse a Codex JSON Schema into a flat `SettingField[]`. Walks each
 * top-level property; if its schema is a typed object (has explicit
 * `properties`), recurse one level and emit each child as `parent.child`.
 * Skips additionalProperties-keyed tables (handled by dedicated panes).
 */
export function parseCodexJsonSchema(schema: JsonSchema): SettingField[] {
  if (!schema.properties) return [];
  const fields: SettingField[] = [];

  for (const [topKey, rawTop] of Object.entries(schema.properties)) {
    const topProp = normalize(rawTop, schema);
    const category = categorizeTopLevel(topKey);

    if (ADDITIONAL_PROPERTIES_TABLES.has(topKey)) {
      // One "managed-elsewhere" entry per additionalProperties table —
      // surfaces the table's existence + a hint to the right pane, but no
      // click-to-insert (keys come from user input, not a fixed schema).
      fields.push({
        key: topKey,
        label: tomlKeyToLabel(topKey),
        type: "object",
        description:
          MANAGED_ELSEWHERE_LABEL[topKey] ??
          topProp.description ??
          `User-keyed table; managed in a dedicated pane.`,
        category: "managed-elsewhere",
        scopes: ["user", "project"],
      });
      continue;
    }

    const isTypedObject =
      topProp.type === "object" &&
      topProp.properties &&
      Object.keys(topProp.properties).length > 0;

    if (!isTypedObject) {
      const { type, choices } = jsonSchemaToFieldType(topProp);
      fields.push({
        key: topKey,
        label: tomlKeyToLabel(topKey),
        type,
        description: topProp.description ?? rawTop.description ?? "",
        choices,
        category,
        scopes: ["user", "project"],
      });
      continue;
    }

    // Typed object: emit each child as `parent.child`. Top-level table
    // itself isn't emitted as a click-to-insert target (the children are
    // the leaf inserts).
    for (const [childKey, rawChild] of Object.entries(topProp.properties!)) {
      const childProp = normalize(rawChild, schema);
      const { type, choices } = jsonSchemaToFieldType(childProp);
      fields.push({
        key: `${topKey}.${childKey}`,
        label: tomlKeyToLabel(`${topKey}.${childKey}`),
        type,
        description: childProp.description ?? rawChild.description ?? "",
        choices,
        category,
        scopes: ["user", "project"],
      });
    }
  }

  return fields;
}

/**
 * Default value for a Codex setting. Same idea as Claude's `defaultForType`
 * but TOML-flavored: enum picks first choice, boolean defaults to true
 * (insertion is opt-in change), string is empty, number is 0, arrays/objects
 * empty containers.
 */
export function defaultForCodexType(field: SettingField): unknown {
  if (field.choices && field.choices.length > 0) return field.choices[0];
  switch (field.type) {
    case "boolean":
      return true;
    case "string":
      return "";
    case "number":
      return 0;
    case "stringArray":
      return [];
    case "stringMap":
      return {};
    case "object":
      return {};
    case "enum":
      return "";
    default:
      return "";
  }
}

/** Build the full Codex settings schema. Mirrors `buildSettingsSchema`
 * tier ordering (JSON Schema is the authoritative source; CLI options and
 * binary fields are unused for Codex but accepted for shape parity). */
export function buildCodexSettingsSchema(
  jsonSchema: JsonSchema | null,
): SettingField[] {
  return jsonSchema ? parseCodexJsonSchema(jsonSchema) : [];
}

/** Group fields into the Codex-specific category order. */
export function groupCodexByCategory(fields: SettingField[]): Map<string, SettingField[]> {
  const groups = new Map<string, SettingField[]>();
  for (const cat of CODEX_CATEGORY_ORDER) groups.set(cat, []);
  for (const field of fields) {
    const arr = groups.get(field.category) ?? [];
    arr.push(field);
    groups.set(field.category, arr);
  }
  for (const [k, v] of groups) {
    if (v.length === 0) groups.delete(k);
  }
  return groups;
}

/** Type-mismatch detection for a parsed TOML object against the Codex schema. */
export function getCodexTypeMismatches(
  parsed: Record<string, unknown>,
  schema: SettingField[],
): { key: string; expected: string; actual: string }[] {
  const fieldMap = new Map(schema.map((f) => [f.key, f]));
  const mismatches: { key: string; expected: string; actual: string }[] = [];

  const visit = (obj: unknown, prefix: string): void => {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const field = fieldMap.get(path);
      if (field && v !== null && v !== undefined) {
        const actual = Array.isArray(v) ? "array" : typeof v;
        let ok = false;
        switch (field.type) {
          case "boolean":
            ok = actual === "boolean";
            break;
          case "number":
            ok = actual === "number";
            break;
          case "string":
          case "enum":
            ok = actual === "string";
            break;
          case "stringArray":
            ok = actual === "array";
            break;
          case "stringMap":
          case "object":
            ok = actual === "object";
            break;
        }
        if (!ok) mismatches.push({ key: path, expected: field.type, actual });
      }
      // Recurse into nested objects so we catch mismatches like
      // `shell_environment_policy.inherit = 5`.
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        visit(v, path);
      }
    }
  };

  visit(parsed, "");
  return mismatches;
}

/** Which keys present in the parsed TOML aren't in the Codex schema?
 * Accepts the `currentKeys` set already computed by `flattenTomlKeys`.
 *
 * Acceptance rules:
 *   1. Exact match against a flattened schema entry (`shell_environment_policy.inherit`).
 *   2. The top-level segment matches a schema entry (covers bare parent
 *      keys like `shell_environment_policy` AND deeper nesting like
 *      `shell_environment_policy.set.OPENAI_API_KEY` whose middle table
 *      isn't enumerated in the schema).
 *   3. The top-level segment is one of the additionalProperties-keyed
 *      tables (`mcp_servers.docs.command`, `profiles.dev.model`).
 */
export function getCodexUnknownKeys(
  currentKeys: Set<string>,
  schema: SettingField[],
): string[] {
  const known = new Set(schema.map((f) => f.key));
  // Build the set of top-level segments touched by the schema so bare table
  // parents and their unenumerated descendants are accepted.
  const knownTopLevels = new Set<string>();
  for (const f of schema) {
    knownTopLevels.add(f.key.split(".")[0]);
  }
  for (const table of ADDITIONAL_PROPERTIES_TABLES) knownTopLevels.add(table);

  return Array.from(currentKeys).filter((k) => {
    if (known.has(k)) return false;
    const top = k.split(".")[0];
    if (knownTopLevels.has(top)) return false;
    return true;
  });
}
