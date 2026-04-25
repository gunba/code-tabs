import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import type { PaneComponentProps } from "./ThreePaneEditor";
import { insertTextAtCursor } from "../../lib/domEdit";
import "./MarkdownPane.css";

// [CM-14] Scope-to-fileType mapping.
const CLAUDE_SCOPE_TO_FILETYPE: Record<string, string> = {
  user: "claudemd-user",
  project: "claudemd-root",
  "project-local": "claudemd-local",
};

const CODEX_SCOPE_TO_FILETYPE: Record<string, string> = {
  user: "agentsmd-user",
  project: "agentsmd-root",
  "project-local": "agentsmd-local",
};

export function MarkdownPane({ scope, projectDir, cli, onStatus }: PaneComponentProps) {
  const [saved, setSaved] = useState("");
  const [current, setCurrent] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [seedKey, setSeedKey] = useState(0);

  const fileType = (cli === "codex" ? CODEX_SCOPE_TO_FILETYPE : CLAUDE_SCOPE_TO_FILETYPE)[scope];
  const docName = cli === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const peerCli = cli === "codex" ? "claude" : "codex";
  const peerName = peerCli === "codex" ? "Codex" : "Claude";
  const peerFileType = (peerCli === "codex" ? CODEX_SCOPE_TO_FILETYPE : CLAUDE_SCOPE_TO_FILETYPE)[scope];
  const workingDir = scope === "user" ? "" : projectDir;

  const load = useCallback(async () => {
    let result = "";
    try {
      result = await invoke<string>("read_config_file", {
        scope,
        workingDir,
        fileType,
      });
    } catch {
      result = "";
    }
    setSaved(result);
    setCurrent(result);
    setSeedKey((k) => k + 1);
    setLoading(false);
  }, [scope, workingDir, fileType]);

  useEffect(() => { load(); }, [load]);

  const handleSave = useCallback(async () => {
    const value = textareaRef.current?.value ?? current;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType,
        content: value,
      });
      setSaved(value);
      onStatus({ text: `${docName} saved`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [current, scope, workingDir, fileType, docName, onStatus]);

  const handleCopyFromPeer = useCallback(async () => {
    try {
      const result = await invoke<string>("read_config_file", {
        scope,
        workingDir,
        fileType: peerFileType,
      });
      if (!result.trim()) {
        onStatus({ text: `No ${peerName} instructions found`, type: "error" });
        return;
      }
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType,
        content: result,
      });
      setSaved(result);
      setCurrent(result);
      setSeedKey((k) => k + 1);
      onStatus({ text: `Copied instructions from ${peerName}`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Copy failed: ${err}`, type: "error" });
    }
  }, [scope, workingDir, peerFileType, peerName, fileType, onStatus]);

  const handleLinkFromPeer = useCallback(async () => {
    try {
      await invoke("symlink_config_file", {
        scope,
        workingDir,
        sourceFileType: peerFileType,
        destFileType: fileType,
        overwrite: true,
      });
      await load();
      onStatus({ text: `Linked instructions from ${peerName}`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Link failed: ${err}`, type: "error" });
    }
  }, [scope, workingDir, peerFileType, fileType, peerName, load, onStatus]);

  const dirty = current !== saved;

  if (loading) return <div className="pane-hint">Loading...</div>;

  return (
    <div className="pane-editor">
      {preview ? (
        <div className="md-preview">
          <ReactMarkdown>{current || "*No content*"}</ReactMarkdown>
        </div>
      ) : (
        <textarea
          // [NU-01] Uncontrolled (defaultValue+onInput): browser owns value and native undo stack; key={seedKey} remounts on source change
          // Remount on each successful load so `defaultValue` reseeds. Mid-edit
          // the browser owns the value and the native undo stack.
          key={seedKey}
          ref={textareaRef}
          className="pane-textarea pane-textarea-md"
          defaultValue={current}
          onInput={(e) => setCurrent(e.currentTarget.value)}
          spellCheck={false}
          placeholder={`No ${docName} found - type to create`}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "s") { e.preventDefault(); handleSave(); }
            if (e.key === "Tab") {
              e.preventDefault();
              insertTextAtCursor(e.currentTarget, "  ");
            }
          }}
        />
      )}
      <div className="pane-footer">
        <button // [CM-23] Preview/Edit toggle with ReactMarkdown rendering
          className={`pane-preview-btn${preview ? " pane-preview-btn-active" : ""}`}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Edit" : "Preview"}
        </button>
        <button className="pane-secondary-btn" onClick={handleCopyFromPeer}>
          Copy from {peerName}
        </button>
        <button className="pane-secondary-btn" onClick={handleLinkFromPeer}>
          Link from {peerName}
        </button>
        <button className="pane-save-btn" onClick={handleSave} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
