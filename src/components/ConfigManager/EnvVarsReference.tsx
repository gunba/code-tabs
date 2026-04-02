import { useMemo } from "react";
import type { EnvVarEntry } from "../../lib/envVars";
import { SCOPES } from "./ThreePaneEditor";

type Scope = "user" | "project" | "project-local";

interface EnvVarsReferenceProps {
  envVars: EnvVarEntry[];
  scopeEnvKeys: Record<Scope, Set<string>>;
  activeScope: Scope;
  onInsert: (name: string) => void;
  filter: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function EnvVarsReference({
  envVars,
  scopeEnvKeys,
  activeScope,
  onInsert,
  filter,
  collapsed,
  onToggleCollapsed,
}: EnvVarsReferenceProps) {
  const filtered = useMemo(() => {
    const lf = filter.toLowerCase();
    const list = lf
      ? envVars.filter(
          (v) => v.name.toLowerCase().includes(lf) || v.description.toLowerCase().includes(lf)
        )
      : envVars;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [envVars, filter]);

  const activeEnvKeys = scopeEnvKeys[activeScope];
  const activeScopeColor = SCOPES.find((s) => s.value === activeScope)?.colorVar ?? "var(--accent)";

  return (
    <div className={`sr-panel sr-panel-wide${collapsed ? "" : " sr-panel-expanded"}`}>
      <button
        className="sr-toggle"
        onClick={onToggleCollapsed}
        onKeyDown={(e) => {
          if (e.key === " " && e.ctrlKey) { e.preventDefault(); onToggleCollapsed(); }
        }}
      >
        <span className="sr-toggle-arrow">{collapsed ? "\u25b6" : "\u25bc"}</span>
        <span>Env Vars</span>
        <span className="sr-toggle-count">
          {filter ? `${filtered.length} of ${envVars.length}` : envVars.length}
        </span>
      </button>

      {!collapsed && (
        <div
          className="sr-body sr-body-wide"
          style={{ "--active-scope-color": activeScopeColor } as React.CSSProperties}
        >
          {filtered.length === 0 && (
            <div className="sr-empty">No matching env vars</div>
          )}
          {filtered.map((v) => {
            const isSetInActive = activeEnvKeys.has(v.name);
            const setInScopes = SCOPES.filter((s) => scopeEnvKeys[s.value as Scope].has(v.name));

            return (
              <button
                key={v.name}
                className={`sr-field ev-entry${isSetInActive ? " sr-field-set" : ""}`}
                onClick={() => {
                  if (!isSetInActive) onInsert(v.name);
                }}
                title={isSetInActive ? `Already set in ${activeScope}` : `Click to insert ${v.name} into ${activeScope}`}
              >
                <div className="sr-field-header">
                  <span className="sr-field-key">{v.name}</span>
                  <span className={`sr-type-badge ${v.documented ? "ev-badge-documented" : "ev-badge-discovered"}`}>
                    {v.documented ? "documented" : "discovered"}
                  </span>
                  {isSetInActive && <span className="sr-field-check">{"\u2713"}</span>}
                </div>
                <div className="sr-field-desc" title={v.description || undefined}>{v.description}</div>
                {setInScopes.length > 0 && (
                  <div className="ev-scope-chips">
                    {setInScopes.map((s) => (
                      <span
                        key={s.value}
                        className="ev-scope-chip"
                        style={{ background: s.colorVar }}
                        title={`Set in ${s.label}`}
                      >
                        {s.label}
                      </span>
                    ))}
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
