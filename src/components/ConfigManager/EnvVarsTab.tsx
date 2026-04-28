import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { scopePath, SCOPES } from "./ThreePaneEditor";
import type { PaneComponentProps } from "./ThreePaneEditor";
import type { CliKind } from "../../types/session";
import { formatScopePath } from "../../lib/paths";
import { useLocalStorageBoolean } from "../../hooks/useLocalStorageBoolean";
import { useSettingsStore } from "../../store/settings";
import { highlightJson } from "./SettingsPane";
import { EnvVarsReference } from "./EnvVarsReference";
import { replaceTextareaValue } from "../../lib/domEdit";
import type { StatusMessage } from "../../lib/settingsSchema";
import { useUnsavedTextEditor } from "./UnsavedTextEditors";

type Scope = PaneComponentProps["scope"];

interface EnvVarsTabProps {
  projectDir: string;
  cli: CliKind;
  onStatus: (msg: StatusMessage | null) => void;
}

export function EnvVarsTab({ projectDir, cli, onStatus }: EnvVarsTabProps) {
  const [activeScope, setActiveScope] = useState<Scope>("user");
  const [scopeEnvKeys, setScopeEnvKeys] = useState<Record<Scope, Set<string>>>({
    user: new Set(),
    project: new Set(),
    "project-local": new Set(),
  });
  const [filter, setFilter] = useState("");
  const [collapsed, toggleCollapsed] = useLocalStorageBoolean("env-vars-ref-collapsed");

  const insertRefs = {
    user: useRef<((name: string) => void) | null>(null),
    project: useRef<((name: string) => void) | null>(null),
    "project-local": useRef<((name: string) => void) | null>(null),
  };

  const makeEnvKeysHandler = useCallback(
    (scope: Scope) => (keys: Set<string>) => {
      setScopeEnvKeys((prev) => {
        if (prev[scope] === keys) return prev;
        return { ...prev, [scope]: keys };
      });
    },
    [],
  );

  const knownEnvVarsByCli = useSettingsStore((s) => s.knownEnvVarsByCli);
  const envVars = knownEnvVarsByCli[cli] ?? [];

  return (
    <div className="settings-tab">
      <div className="three-pane-grid">
        {SCOPES.map(({ value, label, colorVar, icon }) => (
          <div key={value} className="three-pane-column" style={{ "--scope-color": colorVar } as React.CSSProperties}>
            <div className="three-pane-header">
              <span className="three-pane-icon" style={{ color: colorVar }}>{icon}</span>
              <span className="three-pane-label">{label}</span>
              <span className="three-pane-path">
                {cli === "codex"
                  ? `Code Tabs spawn env (${label.toLowerCase()})`
                  : formatScopePath(scopePath(value, projectDir, "settings"))}
              </span>
            </div>
            <div className="three-pane-body">
              <EnvPane
                cli={cli}
                scope={value}
                projectDir={projectDir}
                onStatus={onStatus}
                onEnvKeysChange={makeEnvKeysHandler(value)}
                insertRef={insertRefs[value]}
                onEditorFocus={() => setActiveScope(value)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="settings-search-bar">
        <input
          className="settings-search-input"
          type="text"
          placeholder="Search env vars..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <EnvVarsReference
        envVars={envVars}
        scopeEnvKeys={scopeEnvKeys}
        activeScope={activeScope}
        onInsert={(name) => insertRefs[activeScope].current?.(name)}
        filter={filter}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />
    </div>
  );
}

interface EnvPaneProps {
  cli: CliKind;
  scope: Scope;
  projectDir: string;
  onStatus: (msg: StatusMessage | null) => void;
  onEnvKeysChange?: (keys: Set<string>) => void;
  insertRef?: React.MutableRefObject<((name: string) => void) | null>;
  onEditorFocus?: () => void;
}

function EnvPane({ cli, scope, projectDir, onStatus, onEnvKeysChange, insertRef, onEditorFocus }: EnvPaneProps) {
  const [text, setText] = useState("{}");
  const [saved, setSaved] = useState("{}");
  const [loading, setLoading] = useState(true);
  const [seedKey, setSeedKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    let formatted = "{}";
    try {
      if (cli === "codex") {
        // Codex spawn env lives in a sidecar JSON in Code Tabs appdata,
        // NOT in any file Codex itself reads. Code Tabs injects these vars
        // when spawning the codex process.
        const env = await invoke<Record<string, string>>("read_codex_spawn_env", {
          scope,
          workingDir: scope === "user" ? "" : projectDir,
        });
        formatted = JSON.stringify(env ?? {}, null, 2);
      } else {
        const result = await invoke<string>("read_config_file", {
          scope,
          workingDir: scope === "user" ? "" : projectDir,
          fileType: "settings",
        });
        const settings = result ? (JSON.parse(result) as Record<string, unknown>) : {};
        const env = (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env))
          ? settings.env as Record<string, unknown>
          : {};
        formatted = JSON.stringify(env, null, 2);
      }
    } catch {
      formatted = "{}";
    }
    setText(formatted);
    setSaved(formatted);
    setSeedKey((k) => k + 1);
    setLoading(false);
  }, [cli, scope, projectDir]);

  useEffect(() => { load(); }, [load]);

  const { envKeys, parseError } = useMemo(() => {
    try {
      return { envKeys: new Set(Object.keys(JSON.parse(text))), parseError: null as string | null };
    } catch (e) {
      return { envKeys: new Set<string>(), parseError: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);

  useEffect(() => { onEnvKeysChange?.(envKeys); }, [envKeys, onEnvKeysChange]);

  // Insert via execCommand so the change becomes one undoable step rather than
  // wiping the native undo stack. Read from the DOM (not state) for freshness.
  const handleInsert = useCallback((name: string) => {
    const el = textareaRef.current;
    if (!el) return;
    let next: string | null = null;
    try {
      const obj = JSON.parse(el.value) as Record<string, string>;
      if (name in obj) return;
      next = JSON.stringify({ ...obj, [name]: "" }, null, 2);
    } catch {
      return;
    }
    if (next != null) replaceTextareaValue(el, next);
  }, []);

  useEffect(() => {
    if (insertRef) insertRef.current = handleInsert;
    return () => { if (insertRef) insertRef.current = null; };
  }, [handleInsert, insertRef]);

  const handleSave = useCallback(async () => {
    const value = textareaRef.current?.value ?? text;
    let newEnv: Record<string, string>;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      // Coerce to string-only for both backends (settings.env is string-keyed too).
      newEnv = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch (err) {
      onStatus({ text: `Invalid JSON: ${err}`, type: "error" });
      return;
    }
    try {
      if (cli === "codex") {
        await invoke("write_codex_spawn_env", {
          scope,
          workingDir: scope === "user" ? "" : projectDir,
          env: newEnv,
        });
      } else {
        const current = await invoke<string>("read_config_file", {
          scope,
          workingDir: scope === "user" ? "" : projectDir,
          fileType: "settings",
        });
        const full = current ? (JSON.parse(current) as Record<string, unknown>) : {};
        full.env = newEnv;
        const content = JSON.stringify(full, null, 2);
        await invoke("write_config_file", {
          scope,
          workingDir: scope === "user" ? "" : projectDir,
          fileType: "settings",
          content,
        });
      }
      setSaved(value);
      onStatus({ text: "Env vars saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [cli, text, scope, projectDir, onStatus]);

  const syncScroll = () => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
      preRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  const dirty = text !== saved;

  useUnsavedTextEditor(`env:${scope}:${projectDir}`, () => {
    if (loading) return null;
    const after = textareaRef.current?.value ?? text;
    if (after === saved) return null;
    const scopeLabel = scope === "project-local" ? "Project local" : scope === "project" ? "Project" : "User";
    return {
      title: `Env vars (${scopeLabel})`,
      before: saved,
      after,
    };
  });

  if (loading) return <div className="pane-hint">Loading...</div>;

  return (
    <div className="pane-editor" onFocus={onEditorFocus}>
      <div className="sh-container">
        <pre
          ref={preRef}
          className="sh-pre"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: highlightJson(text) + "\n" }}
        />
        <textarea
          // Remount on each successful load so `defaultValue` reseeds. Mid-edit
          // the textarea owns its value and undo stack; React mirrors via
          // onInput so the overlay and validation stay in sync.
          key={seedKey}
          ref={textareaRef}
          className="pane-textarea sh-textarea"
          defaultValue={text}
          onInput={(e) => setText(e.currentTarget.value)}
          spellCheck={false}
          onScroll={syncScroll}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "s") { e.preventDefault(); handleSave(); }
          }}
        />
      </div>

      <div className="pane-footer">
        {parseError && (
          <span className="sr-validation">
            <span className="sr-validation-error">Invalid JSON</span>
          </span>
        )}
        {!parseError && envKeys.size > 0 && (
          <span className="sr-validation sr-validation-ok">Valid</span>
        )}
        <button className="pane-save-btn" onClick={handleSave} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
