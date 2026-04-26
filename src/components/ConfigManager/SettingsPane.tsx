import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneComponentProps } from "./ThreePaneEditor";
import { useSettingsStore } from "../../store/settings";
import { replaceTextareaValue } from "../../lib/domEdit";
import {
  buildSettingsSchema,
  groupByCategory,
  getUnknownKeys,
  getTypeMismatches,
  getSchemaSourceInfo,
  summarizeList,
  defaultForType,
} from "../../lib/settingsSchema";
import type { SettingField } from "../../lib/settingsSchema";
import { useUnsavedTextEditor } from "./UnsavedTextEditors";

// [CM-13] JSON textarea with syntax highlighting overlay (pre behind transparent textarea)
/** Tokenize JSON text and wrap tokens in colored spans. */
export function highlightJson(text: string): string {
  // Escape HTML first
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Tokenize: keys, strings, numbers, booleans/null, punctuation
  return escaped.replace(
    /("(?:[^"\\]|\\.)*")\s*:/g,
    '<span class="sh-key">$1</span>:'
  ).replace(
    /:\s*("(?:[^"\\]|\\.)*")/g,
    (match, str) => match.replace(str, `<span class="sh-string">${str}</span>`)
  ).replace(
    // Standalone strings in arrays
    /(?<=[\[,]\s*)("(?:[^"\\]|\\.)*")(?=\s*[,\]])/g,
    '<span class="sh-string">$1</span>'
  ).replace(
    /\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,
    '<span class="sh-number">$1</span>'
  ).replace(
    /\b(true|false|null)\b/g,
    '<span class="sh-bool">$1</span>'
  );
}

const TYPE_BADGE_CLASS: Record<string, string> = {
  boolean: "sr-type-boolean",
  string: "sr-type-string",
  number: "sr-type-number",
  enum: "sr-type-enum",
  stringArray: "sr-type-array",
  stringMap: "sr-type-object",
  object: "sr-type-object",
};

/** Insert a key:value into a JSON string before the closing brace */
export function insertIntoJson(json: string, key: string, value: unknown): string {
  const trimmed = json.trim();
  if (!trimmed || trimmed === "{}") {
    return JSON.stringify({ [key]: value }, null, 2);
  }

  try {
    const obj = JSON.parse(trimmed);
    obj[key] = value;
    return JSON.stringify(obj, null, 2);
  } catch {
    // If JSON is invalid, append before last }
    const lastBrace = trimmed.lastIndexOf("}");
    if (lastBrace === -1) return trimmed;
    const before = trimmed.slice(0, lastBrace).trimEnd();
    const needsComma = before.length > 1 && !before.endsWith(",") && !before.endsWith("{");
    const insertion = `${needsComma ? "," : ""}\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    return before + insertion + "\n}";
  }
}

/**
 * Insert a key:value pair into the `env` sub-object of a settings JSON string.
 * Returns null if `env` exists but is not a plain object (prevents clobbering).
 */
export function insertIntoEnv(json: string, name: string, value: string): string | null {
  const trimmed = json.trim();
  let obj: Record<string, unknown>;
  try {
    obj = trimmed && trimmed !== "{}" ? (JSON.parse(trimmed) as Record<string, unknown>) : {};
  } catch {
    // Malformed JSON — insert cannot proceed safely
    return null;
  }

  // If env exists but is not a plain object, refuse to clobber
  if ("env" in obj && (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env))) {
    return null;
  }

  const env = (obj.env as Record<string, string> | undefined) ?? {};
  obj.env = { ...env, [name]: value };
  return JSON.stringify(obj, null, 2);
}

const CATEGORY_LABELS: Record<string, string> = {
  general: "General",
  permissions: "Permissions",
  environment: "Environment",
  plugins: "Plugins",
  hooks: "Hooks",
  advanced: "Advanced",
};

function SettingsReference({
  schema,
  currentKeys,
  onInsert,
}: {
  schema: SettingField[];
  currentKeys: Set<string>;
  onInsert: (key: string, value: unknown) => void;
}) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("settings-ref-collapsed") === "true"; } catch { return false; }
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("settings-ref-collapsed", String(next));
      return next;
    });
  }, []);

  const grouped = useMemo(() => {
    const lf = filter.toLowerCase();
    const filtered = lf
      ? schema.filter((f) =>
        f.key.toLowerCase().includes(lf) || f.description.toLowerCase().includes(lf)
      )
      : schema;
    return groupByCategory(filtered);
  }, [schema, filter]);

  return (
    <div className="sr-panel">
      <button
        className="sr-toggle"
        onClick={toggleCollapsed}
        onKeyDown={(e) => {
          if (e.key === " " && e.ctrlKey) { e.preventDefault(); toggleCollapsed(); }
        }}
      >
        <span className="sr-toggle-arrow">{collapsed ? "\u25b6" : "\u25bc"}</span>
        <span>Available Settings</span>
        <span className="sr-toggle-count">{schema.length}</span>
        {!collapsed && (
          <input
            className="sr-filter"
            type="text"
            placeholder="Filter..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
      </button>

      {!collapsed && (
        <div className="sr-body">
          {grouped.size === 0 && (
            <div className="sr-empty">No matching settings</div>
          )}
          {Array.from(grouped.entries()).map(([category, fields]) => (
            <div key={category} className="sr-category">
              <div className="sr-category-header">{CATEGORY_LABELS[category] ?? category}</div>
              {fields.map((field) => {
                const isSet = currentKeys.has(field.key);
                return (
                  <button
                    key={field.key}
                    className={`sr-field ${isSet ? "sr-field-set" : ""}`}
                    onClick={() => {
                      if (!isSet) onInsert(field.key, defaultForType(field));
                    }}
                    title={isSet ? "Already set" : `Click to insert "${field.key}"`}
                  >
                    <div className="sr-field-header">
                      <span className="sr-field-key">{field.key}</span>
                      <span className={`sr-type-badge ${TYPE_BADGE_CLASS[field.type] ?? ""}`}>
                        {field.type === "stringArray" ? "string[]" :
                          field.type === "stringMap" ? "Record" : field.type}
                      </span>
                      {isSet && <span className="sr-field-check">{"\u2713"}</span>}
                    </div>
                    <div className="sr-field-desc">
                      {field.description.length > 100
                        ? field.description.slice(0, 100) + "..."
                        : field.description}
                    </div>
                    {field.choices && (
                      <div className="sr-field-choices">
                        {field.choices.join(" | ")}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface SettingsPaneExtraProps {
  hideReference?: boolean;
  onKeysChange?: (keys: Set<string>) => void;
  insertRef?: React.MutableRefObject<((key: string, value: unknown) => void) | null>;
  onEditorFocus?: () => void;
}

export function SettingsPane({ scope, projectDir, cli, onStatus, hideReference, onKeysChange, insertRef, onEditorFocus }: PaneComponentProps & SettingsPaneExtraProps) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [seedKey, setSeedKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const { cliCapabilitiesByCli, binarySettingsSchema, settingsJsonSchema } = useSettingsStore();
  const cliCapabilities = cliCapabilitiesByCli[cli] ?? { models: [], permissionModes: [], flags: [], options: [], commands: [] };

  const { schema, sourceInfo } = useMemo(() => ({
    schema: cli === "claude" ? buildSettingsSchema(cliCapabilities.options, binarySettingsSchema, settingsJsonSchema) : [],
    sourceInfo: getSchemaSourceInfo(cliCapabilities.options, binarySettingsSchema, settingsJsonSchema),
  }), [cli, cliCapabilities.options, binarySettingsSchema, settingsJsonSchema]);

  // Parse current JSON for validation + "already set" tracking
  const { currentKeys, unknownKeys, typeMismatches, parseError } = useMemo(() => {
    if (cli === "codex") {
      return {
        currentKeys: new Set<string>(),
        unknownKeys: [] as string[],
        typeMismatches: [] as { key: string; expected: string; actual: string }[],
        parseError: null as string | null,
      };
    }
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return {
        currentKeys: new Set(Object.keys(obj)),
        unknownKeys: getUnknownKeys(obj, schema),
        typeMismatches: getTypeMismatches(obj, schema),
        parseError: null as string | null,
      };
    } catch (e) {
      return {
        currentKeys: new Set<string>(),
        unknownKeys: [] as string[],
        typeMismatches: [] as { key: string; expected: string; actual: string }[],
        parseError: e instanceof Error ? e.message : String(e),
      };
    }
  }, [cli, text, schema]);

  const load = useCallback(async () => {
    let formatted: string;
    try {
      const result = await invoke<string>("read_config_file", {
        scope,
        workingDir: scope === "user" ? "" : projectDir,
        fileType: cli === "codex" ? "codex-config" : "settings",
      });
      formatted = cli === "codex"
        ? result
        : result ? JSON.stringify(JSON.parse(result), null, 2) : "{}";
    } catch {
      formatted = cli === "codex" ? "" : "{}";
    }
    setText(formatted);
    setSaved(formatted);
    setSeedKey((k) => k + 1);
    setLoading(false);
  }, [scope, projectDir, cli]);

  useEffect(() => { load(); }, [load]);

  const handleSave = useCallback(async () => {
    const value = textareaRef.current?.value ?? "";
    if (cli === "claude") {
      try {
        JSON.parse(value); // validate
      } catch (err) {
        onStatus({ text: `Invalid JSON: ${err}`, type: "error" });
        return;
      }
    }
    try {
      await invoke("write_config_file", {
        scope,
        workingDir: scope === "user" ? "" : projectDir,
        fileType: cli === "codex" ? "codex-config" : "settings",
        content: value,
      });
      setSaved(value);
      onStatus({ text: cli === "codex" ? "Codex config saved" : "Settings saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [cli, scope, projectDir, onStatus]);

  // Insert reformats the entire JSON document. We replace the textarea value
  // through the browser's edit history (execCommand) so the change is a single
  // undoable step that doesn't reset the native undo stack — and we read the
  // current value off the DOM (not React state) to avoid acting on stale data.
  const handleInsert = useCallback((key: string, value: unknown) => {
    const el = textareaRef.current;
    if (!el) return;
    const newJson = (() => {
      try {
        return insertIntoJson(el.value, key, value);
      } catch {
        return el.value;
      }
    })();
    replaceTextareaValue(el, newJson);
  }, []);

  // Report current keys to parent
  useEffect(() => {
    onKeysChange?.(currentKeys);
  }, [currentKeys, onKeysChange]);

  // Expose handleInsert via ref
  useEffect(() => {
    if (insertRef) insertRef.current = handleInsert;
    return () => { if (insertRef) insertRef.current = null; };
  }, [handleInsert, insertRef]);

  const syncScroll = () => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
      preRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  const dirty = text !== saved;

  useUnsavedTextEditor(`${cli}:settings:${scope}:${projectDir}`, () => {
    if (loading) return null;
    const after = textareaRef.current?.value ?? text;
    if (after === saved) return null;
    const scopeLabel = scope === "project-local" ? "Project local" : scope === "project" ? "Project" : "User";
    return {
      title: `${cli === "codex" ? "Codex config" : "Settings"} (${scopeLabel})`,
      before: saved,
      after,
    };
  });

  if (loading) return <div className="pane-hint">Loading...</div>;

  // [CM-25] Validation segments for footer (rendered as separate spans for per-segment tooltips)
  const hasErrors = !!parseError || typeMismatches.length > 0;

  const unknownLabel = unknownKeys.length > 0
    ? `${unknownKeys.length} unknown key${unknownKeys.length > 1 ? "s" : ""}: ${summarizeList(unknownKeys)}`
    : null;

  const mismatchLabel = typeMismatches.length > 0
    ? `${typeMismatches.length} type error${typeMismatches.length > 1 ? "s" : ""}: ${summarizeList(typeMismatches.map((m) => `${m.key} (expected ${m.expected}, got ${m.actual})`))}`
    : null;

  // Tooltip explaining schema completeness — only for unknown keys segment
  const unknownTooltip = unknownKeys.length > 0
    ? sourceInfo.hasSchemaStore
      ? "Schema loaded from schemastore.org \u2014 key may be misspelled or from a newer CLI version"
      : sourceInfo.hasCli || sourceInfo.hasBinary
        ? "Schema built from CLI discovery (schemastore.org unavailable) \u2014 key may be valid but undiscoverable"
        : "Limited schema available \u2014 key may be valid"
    : undefined;

  const hasValidation = !!parseError || !!unknownLabel || !!mismatchLabel;

  return (
    <div className="pane-editor" onFocus={onEditorFocus}>
      <div className={cli === "codex" ? "sh-container sh-container-plain" : "sh-container"}>
        {cli === "claude" && (
          <pre
            ref={preRef}
            className="sh-pre"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlightJson(text) + "\n" }}
          />
        )}
        <textarea
          // Remount on each successful load (or scope change) so `defaultValue`
          // reseeds. The browser owns the textarea's value and undo stack
          // mid-edit; React mirrors via onInput for the overlay/validation.
          key={seedKey}
          ref={textareaRef}
          className={cli === "codex" ? "pane-textarea" : "pane-textarea sh-textarea"}
          defaultValue={text}
          onInput={(e) => setText(e.currentTarget.value)}
          spellCheck={false}
          placeholder={cli === "codex" ? "No config.toml found - type TOML to create" : undefined}
          onScroll={syncScroll}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "s") { e.preventDefault(); handleSave(); }
          }}
        />
      </div>

      {cli === "claude" && !hideReference && schema.length > 0 && (
        <SettingsReference
          schema={schema}
          currentKeys={currentKeys}
          onInsert={handleInsert}
        />
      )}

      <div className="pane-footer">
        {cli === "claude" && hasValidation && (
          <span className="sr-validation">
            {parseError && <span className="sr-validation-error">Invalid JSON</span>}
            {parseError && unknownLabel && " \u2022 "}
            {unknownLabel && <span className={hasErrors ? "sr-validation-error" : "sr-validation-warn"} title={unknownTooltip}>{unknownLabel}</span>}
            {(parseError || unknownLabel) && mismatchLabel && " \u2022 "}
            {mismatchLabel && <span className="sr-validation-error">{mismatchLabel}</span>}
          </span>
        )}
        {cli === "claude" && !hasValidation && !parseError && currentKeys.size > 0 && (
          <span className="sr-validation sr-validation-ok">Valid</span>
        )}
        <button className="pane-save-btn" onClick={handleSave} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
