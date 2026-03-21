import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentFile, StatusMessage } from "../../lib/settingsSchema";

interface AgentEditorProps {
  projectDir: string;
  onStatus: (msg: StatusMessage | null) => void;
}

export function AgentEditor({ projectDir, onStatus }: AgentEditorProps) {
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [newAgentName, setNewAgentName] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);

  const loadAgents = useCallback(async () => {
    if (!projectDir) {
      setAgents([]);
      setLoading(false);
      return;
    }
    try {
      const result = await invoke<AgentFile[]>("list_agents", { workingDir: projectDir });
      setAgents(result);
    } catch {
      setAgents([]);
    }
    setLoading(false);
  }, [projectDir]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Load selected agent content (with cancellation to prevent stale writes on rapid selection)
  useEffect(() => {
    if (!selectedAgent) {
      setContent("");
      setSavedContent("");
      return;
    }
    const agent = agents.find((a) => a.name === selectedAgent);
    if (!agent) return;

    let cancelled = false;
    invoke<string>("read_config_file", {
      scope: "project",
      workingDir: projectDir,
      fileType: `agent:${agent.name}`,
    }).then((result) => {
      if (!cancelled) { setContent(result); setSavedContent(result); }
    }).catch(() => {
      if (!cancelled) { setContent(""); setSavedContent(""); }
    });
    return () => { cancelled = true; };
  }, [selectedAgent, agents, projectDir]);

  const handleSave = useCallback(async () => {
    if (!selectedAgent) return;
    try {
      await invoke("write_config_file", {
        scope: "project",
        workingDir: projectDir,
        fileType: `agent:${selectedAgent}`,
        content,
      });
      setSavedContent(content);
      onStatus({ text: "Agent saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [selectedAgent, projectDir, content, onStatus]);

  const handleCreateAgent = useCallback(async () => {
    const name = newAgentName.trim().replace(/\.md$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!name) return;

    const template = `---
model: sonnet
---

You are a specialized agent for ${name}.
`;
    try {
      await invoke("write_config_file", {
        scope: "project",
        workingDir: projectDir,
        fileType: `agent:${name}`,
        content: template,
      });
      setNewAgentName("");
      setShowNewForm(false);
      await loadAgents();
      setSelectedAgent(name);
      onStatus({ text: `Agent "${name}" created`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Create failed: ${err}`, type: "error" });
    }
  }, [newAgentName, projectDir, loadAgents, onStatus]);

  const handleDeleteAgent = useCallback(async () => {
    if (!selectedAgent) return;
    try {
      await invoke("write_config_file", {
        scope: "project",
        workingDir: projectDir,
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
  }, [selectedAgent, projectDir, loadAgents, onStatus]);

  const dirty = content !== savedContent;

  if (loading) return <div className="config-md-hint">Loading...</div>;

  if (!projectDir) {
    return <div className="config-md-hint">No project directory selected. Open a session first.</div>;
  }

  return (
    <div className="config-agents">
      {/* Agent list as pills */}
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
        {showNewForm ? (
          <div className="config-agent-new-row">
            <input
              className="config-input config-agent-new-input"
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              placeholder="agent-name"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateAgent();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setShowNewForm(false);
                  setNewAgentName("");
                }
              }}
              autoFocus
            />
            <button className="config-tag-btn" onClick={handleCreateAgent}>Create</button>
            <button className="config-tag-btn" onClick={() => { setShowNewForm(false); setNewAgentName(""); }}>Cancel</button>
          </div>
        ) : (
          <button
            className="config-agent-add-btn"
            onClick={() => setShowNewForm(true)}
          >
            + New
          </button>
        )}
      </div>

      {/* Agent editor */}
      {selectedAgent ? (
        <div className="config-agent-editor">
          <div className="config-agent-header">
            <span className="config-agent-name">{selectedAgent}.md</span>
            <div className="config-agent-actions">
              <button
                className="config-save-btn"
                onClick={handleSave}
                disabled={!dirty}
              >
                {dirty ? "Save" : "Saved"}
              </button>
              <button
                className="config-agent-delete"
                onClick={handleDeleteAgent}
              >
                Delete
              </button>
            </div>
          </div>
          <textarea
            className="config-md-editor"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.ctrlKey && e.key === "s") {
                e.preventDefault();
                if (dirty) handleSave();
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const ta = e.currentTarget;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                setContent((prev) => prev.slice(0, start) + "  " + prev.slice(end));
                setTimeout(() => {
                  ta.selectionStart = ta.selectionEnd = start + 2;
                }, 0);
              }
            }}
          />
        </div>
      ) : (
        <div className="config-agent-empty">
          {agents.length === 0
            ? "No agents defined in this project."
            : "Select an agent to edit."}
        </div>
      )}
    </div>
  );
}
