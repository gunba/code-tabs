import { parse as smolParse } from "smol-toml";

/** Result of parsing a TOML string. Either the parsed object or a parse error. */
export type TomlParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Parse a TOML string. Treats empty/whitespace-only input as a valid empty table. */
export function parseToml(text: string): TomlParseResult {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = smolParse(text) as Record<string, unknown>;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Walk a parsed TOML object and emit dotted-path keys for every leaf value
 * AND every intermediate table. Used by the Codex Settings reference panel
 * to highlight "already set" entries (the schema is flattened to dotted
 * paths like `shell_environment_policy.inherit`, so the set of currently
 * present keys must be in the same shape).
 *
 * Notes:
 *   * Top-level table keys (`[shell_environment_policy]`) are emitted both as
 *     the bare key (`"shell_environment_policy"`) AND with their child
 *     paths (`"shell_environment_policy.inherit"`), so a reference panel
 *     entry for the parent table OR any of its leaves can show as set.
 *   * Arrays of inline tables (`[[mcp_servers.docs.tools]]`) emit only the
 *     parent path; per-entry leaf paths aren't tracked because users add
 *     these via the dedicated MCP / profile panes, not the reference panel.
 *   * `additionalProperties`-keyed tables (mcp_servers, profiles, …) emit
 *     the parent name plus user-chosen child names (e.g. `mcp_servers.docs`)
 *     so their existence is visible even though the reference panel
 *     doesn't surface them as click-to-insert targets.
 */
export function flattenTomlKeys(value: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const walk = (obj: unknown, prefix: string): void => {
    if (obj === null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      // Don't descend further into arrays — leaf paths inside array-of-tables
      // entries are out of scope for the reference panel.
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        walk(v, path);
      }
    }
  };
  walk(value, "");
  return out;
}
