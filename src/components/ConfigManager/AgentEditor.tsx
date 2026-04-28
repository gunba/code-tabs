import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { insertTextAtCursor } from "../../lib/domEdit";
import type { AgentFile } from "../../lib/settingsSchema";
import type { PaneComponentProps } from "./ThreePaneEditor";
import { useUnsavedTextEditor } from "./UnsavedTextEditors";

// [CM-07] Agent editor: pills + editor, auto-select first, duplicate name validation, Ctrl+S save/create
export function AgentEditor({ scope, projectDir, onStatus }: PaneComponentProps) {
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [newAgentName, setNewAgentName] = useState("");
  const [seedKey, setSeedKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const workingDir = scope === "user" ? "" : projectDir;

  const loadAgents = useCallback(async () => {
    try {
      const result = await invoke<AgentFile[]>("list_agents", { scope, workingDir });
      setAgents(result);
    } catch {
      setAgents([]);
    }
    setLoading(false);
  }, [scope, workingDir]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Auto-select first agent or new-agent mode
  useEffect(() => {
    if (!loading && selectedAgent === null) {
      setSelectedAgent(agents.length > 0 ? agents[0].name : "__new__");
    }
  }, [loading, agents, selectedAgent]);

  // Load selected agent content (with cancellation to prevent stale writes on rapid selection).
  // Bumping seedKey on every transition forces the uncontrolled textarea to
  // remount with a fresh `defaultValue`, preserving the native undo stack
  // mid-edit while still reseeding when selection/load completes.
  useEffect(() => {
    if (!selectedAgent || selectedAgent === "__new__") {
      setContent("");
      setSavedContent("");
      setSeedKey((k) => k + 1);
      return;
    }
    const agent = agents.find((a) => a.name === selectedAgent);
    if (!agent) return;

    let cancelled = false;
    invoke<string>("read_config_file", {
      scope,
      workingDir,
      fileType: `agent:${agent.name}`,
    }).then((result) => {
      if (cancelled) return;
      setContent(result);
      setSavedContent(result);
      setSeedKey((k) => k + 1);
    }).catch(() => {
      if (cancelled) return;
      setContent("");
      setSavedContent("");
      setSeedKey((k) => k + 1);
    });
    return () => { cancelled = true; };
  }, [selectedAgent, agents, scope, workingDir]);

  const handleSave = useCallback(async () => {
    if (!selectedAgent || selectedAgent === "__new__") return;
    const value = textareaRef.current?.value ?? content;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: `agent:${selectedAgent}`,
        content: value,
      });
      setSavedContent(value);
      onStatus({ text: "Agent saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [selectedAgent, scope, workingDir, content, onStatus]);

  const handleCreate = useCallback(async () => {
    const name = newAgentName.trim().replace(/\.md$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!name) return;
    if (agents.some((a) => a.name === name)) {
      onStatus({ text: `Agent "${name}" already exists`, type: "error" });
      return;
    }
    const value = textareaRef.current?.value ?? content;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: `agent:${name}`,
        content: value,
      });
      setNewAgentName("");
      await loadAgents();
      setSelectedAgent(name);
      setSavedContent(value);
      onStatus({ text: `Agent "${name}" created`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Create failed: ${err}`, type: "error" });
    }
  }, [newAgentName, scope, workingDir, content, agents, loadAgents, onStatus]);

  const handleDelete = useCallback(async () => {
    if (!selectedAgent || selectedAgent === "__new__") return;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: `agent-delete:${selectedAgent}`,
        content: "",
      });
      setSelectedAgent(null);
      await loadAgents();
      onStatus({ text: `Agent "${selectedAgent}" deleted`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Delete failed: ${err}`, type: "error" });
    }
  }, [selectedAgent, scope, workingDir, loadAgents, onStatus]);

  const isNew = selectedAgent === "__new__";
  const dirty = isNew ? newAgentName.trim() !== "" && content !== "" : content !== savedContent;

  useUnsavedTextEditor(`agent:${scope}:${projectDir}:${selectedAgent ?? "none"}`, () => {
    if (loading || !selectedAgent) return null;
    const after = textareaRef.current?.value ?? content;
    const scopeLabel = scope === "project" ? "Project" : "User";
    if (isNew) {
      const name = newAgentName.trim();
      if (!name && after === "") return null;
      return {
        title: `New agent${name ? ` "${name}"` : ""} (${scopeLabel})`,
        before: "",
        after: `name=${name}\n\n${after}`,
      };
    }
    if (after === savedContent) return null;
    return {
      title: `Agent ${selectedAgent}.md (${scopeLabel})`,
      before: savedContent,
      after,
    };
  });

  if (loading) return <div className="config-md-hint">Loading...</div>;

  return (
    <div className="config-md-editor">
      <div className="config-md-editor-list">
        {agents.map((agent) => (
          <button
            key={agent.name}
            className={`config-md-editor-item${selectedAgent === agent.name ? " active" : ""}`}
            onClick={() => setSelectedAgent(agent.name)}
          >
            {agent.name}
          </button>
        ))}
        <button
          className={`config-md-editor-item config-md-editor-new${isNew ? " active" : ""}`}
          onClick={() => { setSelectedAgent("__new__"); setNewAgentName(""); }}
        >
          + new agent
        </button>
      </div>

      <div className="config-md-editor-body">
        <div className="config-md-editor-header">
          {isNew ? (
            <input
              className="config-input config-md-editor-name-input"
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              placeholder="agent-name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty) handleCreate();
                if (e.key === "Escape") e.stopPropagation();
              }}
              autoFocus
            />
          ) : (
            <span className="config-md-editor-name">{selectedAgent}.md</span>
          )}
          <div className="config-md-editor-actions">
            <button
              className="config-save-btn"
              onClick={isNew ? handleCreate : handleSave}
              disabled={!dirty}
            >
              {isNew ? "Create" : dirty ? "Save" : "Saved"}
            </button>
            {!isNew && (
              <button className="config-md-editor-delete" onClick={handleDelete}>Delete</button>
            )}
          </div>
        </div>
        <textarea
          // Remount when seedKey changes so `defaultValue` reseeds without
          // React writing into a mounted textarea (which clears native undo).
          key={seedKey}
          ref={textareaRef}
          className="pane-textarea pane-textarea-md"
          defaultValue={content}
          onInput={(e) => setContent(e.currentTarget.value)}
          placeholder={isNew ? "Agent prompt content..." : ""}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "s") {
              e.preventDefault();
              if (dirty) isNew ? handleCreate() : handleSave();
            }
            if (e.key === "Tab") {
              e.preventDefault();
              insertTextAtCursor(e.currentTarget, "  ");
            }
          }}
        />
      </div>
    </div>
  );
}
