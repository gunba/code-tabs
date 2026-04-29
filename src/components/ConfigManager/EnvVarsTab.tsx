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
import { HighlightedTextFileEditor, useTextFileEditor } from "./TextFileEditor";

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
  const workingDir = scope === "user" ? "" : projectDir;
  const scopeLabel = scope === "project-local" ? "Project local" : scope === "project" ? "Project" : "User";

  const read = useCallback(async () => {
    try {
      if (cli === "codex") {
        // Codex spawn env lives in a sidecar JSON in Code Tabs appdata,
        // NOT in any file Codex itself reads. Code Tabs injects these vars
        // when spawning the codex process.
        const env = await invoke<Record<string, string>>("read_codex_spawn_env", {
          scope,
          workingDir,
        });
        return JSON.stringify(env ?? {}, null, 2);
      } else {
        const result = await invoke<string>("read_config_file", {
          scope,
          workingDir,
          fileType: "settings",
        });
        const settings = result ? (JSON.parse(result) as Record<string, unknown>) : {};
        const env = (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env))
          ? settings.env as Record<string, unknown>
          : {};
        return JSON.stringify(env, null, 2);
      }
    } catch {
      return "{}";
    }
  }, [cli, scope, workingDir]);

  const write = useCallback(async (value: string) => {
    let newEnv: Record<string, string>;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      // Coerce to string-only for both backends (settings.env is string-keyed too).
      newEnv = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch (err) {
      throw new Error(`Invalid JSON: ${err}`);
    }
    if (cli === "codex") {
      await invoke("write_codex_spawn_env", {
        scope,
        workingDir,
        env: newEnv,
      });
    } else {
      const current = await invoke<string>("read_config_file", {
        scope,
        workingDir,
        fileType: "settings",
      });
      const full = current ? (JSON.parse(current) as Record<string, unknown>) : {};
      full.env = newEnv;
      const content = JSON.stringify(full, null, 2);
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: "settings",
        content,
      });
    }
  }, [cli, scope, workingDir]);

  const editor = useTextFileEditor({
    id: `env:${scope}:${projectDir}`,
    title: `Env vars (${scopeLabel})`,
    initialText: "{}",
    read,
    write,
  });

  const { envKeys, parseError } = useMemo(() => {
    try {
      return { envKeys: new Set(Object.keys(JSON.parse(editor.text))), parseError: null as string | null };
    } catch (e) {
      return { envKeys: new Set<string>(), parseError: e instanceof Error ? e.message : String(e) };
    }
  }, [editor.text]);

  useEffect(() => { onEnvKeysChange?.(envKeys); }, [envKeys, onEnvKeysChange]);

  // Insert via execCommand so the change becomes one undoable step rather than
  // wiping the native undo stack. Read from the DOM (not state) for freshness.
  const handleInsert = useCallback((name: string) => {
    const el = editor.textareaRef.current;
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
  }, [editor.textareaRef]);

  useEffect(() => {
    if (insertRef) insertRef.current = handleInsert;
    return () => { if (insertRef) insertRef.current = null; };
  }, [handleInsert, insertRef]);

  const handleSave = useCallback(async () => {
    try {
      await editor.save();
      onStatus({ text: "Env vars saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStatus({ text: message.startsWith("Invalid JSON:") ? message : `Save failed: ${message}`, type: "error" });
    }
  }, [editor, onStatus]);

  if (editor.loading) return <div className="pane-hint">Loading...</div>;

  return (
    <div className="pane-editor" onFocus={onEditorFocus}>
      <HighlightedTextFileEditor
        editor={editor}
        highlightedHtml={highlightJson(editor.text)}
        onSave={handleSave}
      />

      <div className="pane-footer">
        {parseError && (
          <span className="sr-validation">
            <span className="sr-validation-error">Invalid JSON</span>
          </span>
        )}
        {!parseError && envKeys.size > 0 && (
          <span className="sr-validation sr-validation-ok">Valid</span>
        )}
        <button className="pane-save-btn" onClick={handleSave} disabled={!editor.dirty}>
          {editor.dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
