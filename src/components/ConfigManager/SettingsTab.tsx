import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { SettingsPane } from "./SettingsPane";
import { scopePath, SCOPES } from "./ThreePaneEditor";
import type { PaneComponentProps } from "./ThreePaneEditor";
import type { CliKind } from "../../types/session";
import { formatScopePath } from "../../lib/paths";
import { useSettingsStore } from "../../store/settings";
import {
  buildSettingsSchema,
  defaultForType,
} from "../../lib/settingsSchema";
import type { SettingField, StatusMessage } from "../../lib/settingsSchema";
import { buildCodexSettingsSchema, defaultForCodexType } from "../../lib/codexSchema";

type Scope = PaneComponentProps["scope"];

const TYPE_BADGE_CLASS: Record<string, string> = {
  boolean: "sr-type-boolean",
  string: "sr-type-string",
  number: "sr-type-number",
  enum: "sr-type-enum",
  stringArray: "sr-type-array",
  stringMap: "sr-type-object",
  object: "sr-type-object",
};

interface SettingsTabProps {
  projectDir: string;
  cli: CliKind;
  onStatus: (msg: StatusMessage | null) => void;
}

// [CM-24] Unified Settings Reference: full-width panel, categorized grid, type badges, click-to-insert
// [CM-06] Per-scope JSON settings editors with dirty tracking and Save per pane
export function SettingsTab({ projectDir, cli, onStatus }: SettingsTabProps) {
  const [activeScope, setActiveScope] = useState<Scope>("user");
  const [scopeKeys, setScopeKeys] = useState<Record<Scope, Set<string>>>({
    user: new Set(),
    project: new Set(),
    "project-local": new Set(),
  });
  const [filter, setFilter] = useState("");
  const [refCollapsed, setRefCollapsed] = useState(() => {
    try { return localStorage.getItem("settings-ref-collapsed") === "true"; } catch { return false; }
  });

  const toggleRefCollapsed = useCallback(() => {
    setRefCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("settings-ref-collapsed", String(next));
      return next;
    });
  }, []);

  const insertRefs = {
    user: useRef<((key: string, value: unknown) => void) | null>(null),
    project: useRef<((key: string, value: unknown) => void) | null>(null),
    "project-local": useRef<((key: string, value: unknown) => void) | null>(null),
  };

  const makeKeysHandler = useCallback(
    (scope: Scope) => (keys: Set<string>) => {
      setScopeKeys((prev) => {
        if (prev[scope] === keys) return prev;
        return { ...prev, [scope]: keys };
      });
    },
    [],
  );

  const { cliCapabilitiesByCli, binarySettingsSchema, settingsJsonSchema, settingsSchemaByCli } = useSettingsStore();
  const cliCapabilities = cliCapabilitiesByCli[cli] ?? { models: [], permissionModes: [], flags: [], options: [], commands: [] };
  const schema = useMemo(
    () => cli === "claude"
      ? buildSettingsSchema(cliCapabilities.options, binarySettingsSchema, settingsJsonSchema)
      : buildCodexSettingsSchema(settingsSchemaByCli.codex),
    [cli, cliCapabilities.options, binarySettingsSchema, settingsJsonSchema, settingsSchemaByCli.codex],
  );
  const visibleScopes = cli === "codex" ? SCOPES.filter((s) => s.value !== "project-local") : SCOPES;
  useEffect(() => {
    if (cli === "codex" && activeScope === "project-local") setActiveScope("project");
  }, [cli, activeScope]);

  return (
    <div className="settings-tab">
      {cli === "codex" && <CodexAppPrefs />}
      <div className="three-pane-grid" style={{ gridTemplateColumns: `repeat(${visibleScopes.length}, 1fr)` }}>
        {visibleScopes.map(({ value, label, colorVar, icon }) => (
          <div key={value} className="three-pane-column" style={{ "--scope-color": colorVar } as React.CSSProperties}>
            <div className="three-pane-header">
              <span className="three-pane-icon" style={{ color: colorVar }}>{icon}</span>
              <span className="three-pane-label">{label}</span>
              <span className="three-pane-path">{formatScopePath(scopePath(value, projectDir, "settings", cli))}</span>
            </div>
            <div className="three-pane-body">
              <SettingsPane
                scope={value}
                projectDir={projectDir}
                cli={cli}
                onStatus={onStatus}
                hideReference
                onKeysChange={makeKeysHandler(value)}
                insertRef={insertRefs[value]}
                onEditorFocus={() => setActiveScope(value)}
              />
            </div>
          </div>
        ))}
      </div>

      {schema.length > 0 && (
        <>
          <div className="settings-search-bar">
            <input
              className="settings-search-input"
              type="text"
              placeholder="Search settings..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <UnifiedSettingsReference
            cli={cli}
            schema={schema}
            scopeKeys={scopeKeys}
            activeScope={activeScope}
            onInsert={(key, value) => insertRefs[activeScope].current?.(key, value)}
            filter={filter}
            collapsed={refCollapsed}
            onToggleCollapsed={toggleRefCollapsed}
          />
        </>
      )}
    </div>
  );
}

function UnifiedSettingsReference({
  cli,
  schema,
  scopeKeys,
  activeScope,
  onInsert,
  filter,
  collapsed,
  onToggleCollapsed,
}: {
  cli: CliKind;
  schema: SettingField[];
  scopeKeys: Record<Scope, Set<string>>;
  activeScope: Scope;
  onInsert: (key: string, value: unknown) => void;
  filter: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const sorted = useMemo(() => {
    const lf = filter.toLowerCase();
    const filtered = lf
      ? schema.filter((f) =>
        f.key.toLowerCase().includes(lf) || f.description.toLowerCase().includes(lf)
      )
      : schema;
    return [...filtered].sort((a, b) => a.key.localeCompare(b.key));
  }, [schema, filter]);

  const activeKeys = scopeKeys[activeScope];

  return (
    <div className={`sr-panel sr-panel-wide${collapsed ? '' : ' sr-panel-expanded'}`}>
      <button
        className="sr-toggle"
        onClick={onToggleCollapsed}
        onKeyDown={(e) => {
          if (e.key === " " && e.ctrlKey) { e.preventDefault(); onToggleCollapsed(); }
        }}
      >
        <span className="sr-toggle-arrow">{collapsed ? "\u25b6" : "\u25bc"}</span>
        <span>Available Settings</span>
        <span className="sr-toggle-count">{filter ? `${sorted.length} of ${schema.length}` : schema.length}</span>
      </button>

      {!collapsed && (
        <div className="sr-body sr-body-wide" style={{ "--active-scope-color": SCOPES.find(s => s.value === activeScope)?.colorVar } as React.CSSProperties}>
          {sorted.length === 0 && (
            <div className="sr-empty">No matching settings</div>
          )}
          {sorted.map((field) => {
            const isSet = activeKeys.has(field.key);
            const managedElsewhere = field.category === "managed-elsewhere";
            return (
              <button
                key={field.key}
                className={`sr-field ${isSet ? "sr-field-set" : ""}${managedElsewhere ? " sr-field-managed" : ""}`}
                onClick={() => {
                  if (managedElsewhere) return;
                  if (!isSet) {
                    onInsert(
                      field.key,
                      cli === "claude" ? defaultForType(field) : defaultForCodexType(field),
                    );
                  }
                }}
                disabled={managedElsewhere}
                title={field.description}
              >
                <div className="sr-field-header">
                  <span className="sr-field-key">{field.key}</span>
                  <span className={`sr-type-badge ${TYPE_BADGE_CLASS[field.type] ?? ""}`}>
                    {field.type === "stringArray" ? "string[]" :
                      field.type === "stringMap" ? "Record" : field.type}
                  </span>
                </div>
                <div className="sr-field-desc">
                  {field.description}
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
      )}
    </div>
  );
}

/**
 * Code Tabs preferences specific to Codex sessions. Lives above the
 * config-file editors because these toggles change app behavior, not
 * Codex's own config.toml.
 */
function CodexAppPrefs() {
  const enabled = useSettingsStore((s) => s.codexAutoRenameLLMEnabled);
  const model = useSettingsStore((s) => s.codexAutoRenameLLMModel);
  const setEnabled = useSettingsStore((s) => s.setCodexAutoRenameLLMEnabled);
  const setModel = useSettingsStore((s) => s.setCodexAutoRenameLLMModel);
  return (
    <div className="codex-app-prefs">
      <div className="codex-app-prefs-title">Code Tabs preferences</div>
      <label className="codex-app-prefs-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="codex-app-prefs-label">Auto-rename tabs via small model</span>
        <span className="codex-app-prefs-hint">
          On the first user message, generate a short tab title via <code>codex exec</code>.
          Reuses your existing Codex auth.
        </span>
      </label>
      <label className={`codex-app-prefs-row${enabled ? "" : " codex-app-prefs-row-disabled"}`}>
        <span className="codex-app-prefs-label">Model</span>
        <input
          type="text"
          className="codex-app-prefs-input"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!enabled}
          placeholder="gpt-5-mini"
          spellCheck={false}
        />
      </label>
    </div>
  );
}
