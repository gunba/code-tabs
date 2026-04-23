import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { writeToPty } from "../../lib/ptyRegistry";
import { abbreviatePath, normalizePath, parseWorktreePath } from "../../lib/paths";
import "./NotesPanel.css";

type SubTab = "conversation" | "project";

function deriveWorkspace(workingDir: string | undefined) {
  if (!workingDir) return { key: "", label: "" };
  const wt = parseWorktreePath(workingDir);
  const projectRoot = wt ? wt.projectRoot : workingDir;
  const key = normalizePath(projectRoot).toLowerCase();
  return { key, label: abbreviatePath(projectRoot) };
}

export function NotesPanel() {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const sessions = useSessionStore((s) => s.sessions);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const workspaceNotes = useSettingsStore((s) => s.workspaceNotes);
  const setWorkspaceNotes = useSettingsStore((s) => s.setWorkspaceNotes);

  const activeSession = sessions.find((s) => s.id === activeTabId) ?? null;
  const { key: wsKey, label: wsLabel } = useMemo(
    () => deriveWorkspace(activeSession?.config.workingDir),
    [activeSession?.config.workingDir],
  );

  const conversationNotes = activeSession?.metadata.notes ?? "";
  const projectNotes = wsKey ? workspaceNotes[wsKey] ?? "" : "";

  const [subTab, setSubTab] = useState<SubTab>("conversation");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // Selection offsets become meaningless when the underlying buffer changes.
  useEffect(() => {
    setHasSelection(false);
  }, [activeTabId, subTab, wsKey]);

  const notes = subTab === "conversation" ? conversationNotes : projectNotes;

  const commitNotes = useCallback(
    (value: string) => {
      if (subTab === "conversation") {
        if (activeTabId) updateMetadata(activeTabId, { notes: value });
      } else {
        if (wsKey) setWorkspaceNotes(wsKey, value);
      }
    },
    [subTab, activeTabId, wsKey, updateMetadata, setWorkspaceNotes],
  );

  const refreshSelection = useCallback(() => {
    const el = textareaRef.current;
    if (!el) {
      setHasSelection(false);
      return;
    }
    setHasSelection(el.selectionStart !== el.selectionEnd);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      commitNotes(e.target.value);
      refreshSelection();
    },
    [commitNotes, refreshSelection],
  );

  const sendAll = useCallback(() => {
    if (!activeTabId) return;
    const text = notes;
    if (text.length === 0) return;
    const ok = writeToPty(activeTabId, text + "\r");
    if (!ok) return;
    // Conversation notes are outbox-style and clear after sending.
    // Project notes are reference material — keep them so they can be reused.
    if (subTab === "conversation") {
      commitNotes("");
      setHasSelection(false);
    }
  }, [activeTabId, notes, subTab, commitNotes]);

  const sendSelected = useCallback(() => {
    if (!activeTabId) return;
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) return;
    const fragment = notes.slice(start, end);
    if (fragment.length === 0) return;
    const ok = writeToPty(activeTabId, fragment + "\r");
    if (!ok) return;
    if (subTab === "conversation") {
      commitNotes(notes.slice(0, start) + notes.slice(end));
      setHasSelection(false);
    }
  }, [activeTabId, notes, subTab, commitNotes]);

  const subTabs: Array<{ id: SubTab; label: string }> = [
    { id: "conversation", label: "Conversation" },
    { id: "project", label: "Project" },
  ];

  if (!activeTabId || !activeSession) {
    return (
      <div className="notes-panel">
        <div className="notes-panel-subtabs" role="tablist" aria-label="Notes scope">
          {subTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={subTab === t.id}
              className={`notes-panel-subtab${subTab === t.id ? " notes-panel-subtab-active" : ""}`}
              onClick={() => setSubTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="notes-panel-empty">Select a session to take notes.</div>
      </div>
    );
  }

  const projectDisabled = subTab === "project" && !wsKey;
  const canSendAll = notes.length > 0 && !projectDisabled;
  const canSendSelected = hasSelection && !projectDisabled;

  const placeholder =
    subTab === "conversation"
      ? "Notes for this conversation. Sent notes are removed from the buffer."
      : "Notes for this project (shared across all sessions in this workspace). Reference material — sending keeps them intact.";

  return (
    <div className="notes-panel">
      <div className="notes-panel-subtabs" role="tablist" aria-label="Notes scope">
        {subTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={subTab === t.id}
            className={`notes-panel-subtab${subTab === t.id ? " notes-panel-subtab-active" : ""}`}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {subTab === "project" && (
        <div className="notes-panel-scope" title={wsLabel || undefined}>
          {wsLabel ? `Workspace: ${wsLabel}` : "No workspace detected for this session."}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="notes-panel-textarea"
        value={notes}
        onChange={handleChange}
        onSelect={refreshSelection}
        onKeyUp={refreshSelection}
        onMouseUp={refreshSelection}
        onBlur={refreshSelection}
        placeholder={placeholder}
        spellCheck={false}
        disabled={projectDisabled}
      />
      <div className="notes-panel-actions">
        <button
          type="button"
          className="notes-panel-button"
          onClick={sendSelected}
          disabled={!canSendSelected}
          title="Send the highlighted text to the agent as a user message"
        >
          Send selected
        </button>
        <button
          type="button"
          className="notes-panel-button notes-panel-button-primary"
          onClick={sendAll}
          disabled={!canSendAll}
          title="Send the entire note to the agent as a user message"
        >
          Send all
        </button>
      </div>
    </div>
  );
}
