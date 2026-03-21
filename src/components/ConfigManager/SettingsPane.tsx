import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneComponentProps } from "./ThreePaneEditor";

export function SettingsPane({ scope, projectDir, onStatus }: PaneComponentProps) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await invoke<string>("read_config_file", {
        scope,
        workingDir: scope === "user" ? "" : projectDir,
        fileType: "settings",
      });
      const formatted = result ? JSON.stringify(JSON.parse(result), null, 2) : "{}";
      setText(formatted);
      setSaved(formatted);
    } catch {
      setText("{}");
      setSaved("{}");
    }
    setLoading(false);
  }, [scope, projectDir]);

  useEffect(() => { load(); }, [load]);

  const handleSave = useCallback(async () => {
    try {
      JSON.parse(text); // validate
    } catch (err) {
      onStatus({ text: `Invalid JSON: ${err}`, type: "error" });
      return;
    }
    try {
      await invoke("write_config_file", {
        scope,
        workingDir: scope === "user" ? "" : projectDir,
        fileType: "settings",
        content: text,
      });
      setSaved(text);
      onStatus({ text: "Settings saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [text, scope, projectDir, onStatus]);

  const dirty = text !== saved;

  if (loading) return <div className="pane-hint">Loading...</div>;

  return (
    <div className="pane-editor">
      <textarea
        className="pane-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === "s") { e.preventDefault(); handleSave(); }
        }}
      />
      <div className="pane-footer">
        <button className="pane-save-btn" onClick={handleSave} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
