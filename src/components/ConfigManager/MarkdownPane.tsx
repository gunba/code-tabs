import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import type { PaneComponentProps } from "./ThreePaneEditor";
import { insertTextAtCursor } from "../../lib/domEdit";
import { TextFileTextarea, useTextFileEditor } from "./TextFileEditor";
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
  const [preview, setPreview] = useState(false);

  const fileType = (cli === "codex" ? CODEX_SCOPE_TO_FILETYPE : CLAUDE_SCOPE_TO_FILETYPE)[scope];
  const docName = cli === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const peerCli = cli === "codex" ? "claude" : "codex";
  const peerName = peerCli === "codex" ? "Codex" : "Claude";
  const peerFileType = (peerCli === "codex" ? CODEX_SCOPE_TO_FILETYPE : CLAUDE_SCOPE_TO_FILETYPE)[scope];
  const workingDir = scope === "user" ? "" : projectDir;
  const scopeLabel = scope === "project-local" ? "Project local" : scope === "project" ? "Project" : "User";

  const read = useCallback(async () => {
    try {
      return await invoke<string>("read_config_file", {
        scope,
        workingDir,
        fileType,
      });
    } catch {
      return "";
    }
  }, [scope, workingDir, fileType]);

  const write = useCallback(async (value: string) => {
    await invoke("write_config_file", {
      scope,
      workingDir,
      fileType,
      content: value,
    });
  }, [scope, workingDir, fileType]);

  const editor = useTextFileEditor({
    id: `${cli}:instructions:${scope}:${projectDir}`,
    title: `${docName} (${scopeLabel})`,
    initialText: "",
    read,
    write,
  });

  const handleSave = useCallback(async () => {
    try {
      await editor.save();
      onStatus({ text: `${docName} saved`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [editor, docName, onStatus]);

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
      editor.reset(result);
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
      await editor.reload();
      onStatus({ text: `Linked instructions from ${peerName}`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Link failed: ${err}`, type: "error" });
    }
  }, [scope, workingDir, peerFileType, fileType, peerName, editor, onStatus]);

  if (editor.loading) return <div className="pane-hint">Loading...</div>;

  return (
    <div className="pane-editor">
      {preview ? (
        <div className="md-preview">
          <ReactMarkdown>{editor.text || "*No content*"}</ReactMarkdown>
        </div>
      ) : (
        <TextFileTextarea
          editor={editor}
          className="pane-textarea pane-textarea-md"
          placeholder={`No ${docName} found - type to create`}
          onSave={handleSave}
          onKeyDown={(e) => {
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
        <button className="pane-save-btn" onClick={handleSave} disabled={!editor.dirty}>
          {editor.dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
