import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import type { PaneComponentProps } from "./ThreePaneEditor";

const SCOPE_TO_FILETYPE: Record<string, string> = {
  user: "claudemd-user",
  project: "claudemd-root",
  "project-local": "claudemd-dotclaude",
};

export function MarkdownPane({ scope, projectDir, onStatus }: PaneComponentProps) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(false);

  const fileType = SCOPE_TO_FILETYPE[scope];

  const load = useCallback(async () => {
    try {
      const result = await invoke<string>("read_config_file", {
        scope: scope === "project-local" ? "project" : scope,
        workingDir: scope === "user" ? "" : projectDir,
        fileType,
      });
      setText(result);
      setSaved(result);
    } catch {
      setText("");
      setSaved("");
    }
    setLoading(false);
  }, [scope, projectDir, fileType]);

  useEffect(() => { load(); }, [load]);

  const handleSave = useCallback(async () => {
    try {
      await invoke("write_config_file", {
        scope: scope === "project-local" ? "project" : scope,
        workingDir: scope === "user" ? "" : projectDir,
        fileType,
        content: text,
      });
      setSaved(text);
      onStatus({ text: "CLAUDE.md saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [text, scope, projectDir, fileType, onStatus]);

  const dirty = text !== saved;

  if (loading) return <div className="pane-hint">Loading...</div>;

  return (
    <div className="pane-editor">
      {preview ? (
        <div className="md-preview">
          <ReactMarkdown>{text || "*No content*"}</ReactMarkdown>
        </div>
      ) : (
        <textarea
          className="pane-textarea pane-textarea-md"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder="No CLAUDE.md found — type to create"
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "s") { e.preventDefault(); handleSave(); }
            if (e.key === "Tab") {
              e.preventDefault();
              const ta = e.currentTarget;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              setText((prev) => prev.slice(0, start) + "  " + prev.slice(end));
              setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + 2; }, 0);
            }
          }}
        />
      )}
      <div className="pane-footer">
        <button
          className={`pane-preview-btn${preview ? " pane-preview-btn-active" : ""}`}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Edit" : "Preview"}
        </button>
        <button className="pane-save-btn" onClick={handleSave} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
