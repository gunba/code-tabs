import { useState, useRef, useCallback, useMemo } from "react";
import { SettingsPane } from "./SettingsPane";
import { scopePath, SCOPES } from "./ThreePaneEditor";
import type { PaneComponentProps } from "./ThreePaneEditor";
import { formatScopePath } from "../../lib/paths";
import { useSettingsStore } from "../../store/settings";
import {
  buildSettingsSchema,
  defaultForType,
} from "../../lib/settingsSchema";
import type { SettingField, StatusMessage } from "../../lib/settingsSchema";

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
  onStatus: (msg: StatusMessage | null) => void;
}

export function SettingsTab({ projectDir, onStatus }: SettingsTabProps) {
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

  const { cliCapabilities, binarySettingsSchema, settingsJsonSchema } = useSettingsStore();
  const schema = useMemo(
    () => buildSettingsSchema(cliCapabilities.options, binarySettingsSchema, settingsJsonSchema),
    [cliCapabilities.options, binarySettingsSchema, settingsJsonSchema],
  );

  return (
    <div className="settings-tab">
      <div className="three-pane-grid">
        {SCOPES.map(({ value, label, colorVar, icon }) => (
          <div key={value} className="three-pane-column" style={{ "--scope-color": colorVar } as React.CSSProperties}>
            <div className="three-pane-header">
              <span className="three-pane-icon" style={{ color: colorVar }}>{icon}</span>
              <span className="three-pane-label">{label}</span>
              <span className="three-pane-path">{formatScopePath(scopePath(value, projectDir, "settings"))}</span>
            </div>
            <div className="three-pane-body">
              <SettingsPane
                scope={value}
                projectDir={projectDir}
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
  schema,
  scopeKeys,
  activeScope,
  onInsert,
  filter,
  collapsed,
  onToggleCollapsed,
}: {
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
            return (
              <button
                key={field.key}
                className={`sr-field ${isSet ? "sr-field-set" : ""}`}
                onClick={() => {
                  if (!isSet) onInsert(field.key, defaultForType(field));
                }}
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
