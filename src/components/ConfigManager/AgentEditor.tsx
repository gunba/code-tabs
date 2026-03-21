import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentFile } from "../../lib/settingsSchema";
import type { PaneComponentProps } from "./ThreePaneEditor";

export function AgentEditor({ scope, projectDir, onStatus }: PaneComponentProps) {
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [newAgentName, setNewAgentName] = useState("");

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

  // Load selected agent content (with cancellation to prevent stale writes on rapid selection)
  useEffect(() => {
    if (!selectedAgent || selectedAgent === "__new__") {
      setContent("");
      setSavedContent("");
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
      if (!cancelled) { setContent(result); setSavedContent(result); }
    }).catch(() => {
      if (!cancelled) { setContent(""); setSavedContent(""); }
    });
    return () => { cancelled = true; };
  }, [selectedAgent, agents, scope, workingDir]);

  const handleSave = useCallback(async () => {
    if (!selectedAgent || selectedAgent === "__new__") return;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: `agent:${selectedAgent}`,
        content,
      });
      setSavedContent(content);
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
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: `agent:${name}`,
        content,
      });
      setNewAgentName("");
      await loadAgents();
      setSelectedAgent(name);
      setSavedContent(content);
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

  if (loading) return <div className="config-md-hint">Loading...</div>;

  return (
    <div className="config-agents">
      <div className="config-agent-list">
        {agents.map((agent) => (
          <button
            key={agent.name}
            className={`config-agent-item${selectedAgent === agent.name ? " active" : ""}`}
            onClick={() => setSelectedAgent(agent.name)}
          >
            {agent.name}
          </button>
        ))}
        <button
          className={`config-agent-item config-agent-new${isNew ? " active" : ""}`}
          onClick={() => { setSelectedAgent("__new__"); setNewAgentName(""); setContent(""); }}
        >
          + new agent
        </button>
      </div>

      <div className="config-agent-editor">
        <div className="config-agent-header">
          {isNew ? (
            <input
              className="config-input config-agent-name-input"
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
            <span className="config-agent-name">{selectedAgent}.md</span>
          )}
          <div className="config-agent-actions">
            <button
              className="config-save-btn"
              onClick={isNew ? handleCreate : handleSave}
              disabled={!dirty}
            >
              {isNew ? "Create" : dirty ? "Save" : "Saved"}
            </button>
            {!isNew && (
              <button className="config-agent-delete" onClick={handleDelete}>Delete</button>
            )}
          </div>
        </div>
        <textarea
          className="pane-textarea pane-textarea-md"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={isNew ? "Agent prompt content..." : ""}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "s") {
              e.preventDefault();
              if (dirty) isNew ? handleCreate() : handleSave();
            }
            if (e.key === "Tab") {
              e.preventDefault();
              const ta = e.currentTarget;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              setContent((prev) => prev.slice(0, start) + "  " + prev.slice(end));
              setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + 2; }, 0);
            }
          }}
        />
      </div>
    </div>
  );
}
