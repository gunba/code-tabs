import { useState, useRef, useEffect, useCallback } from "react";
import { useSettingsStore } from "../../store/settings";
import { IconClose } from "../Icons/Icons";
import type { StatusMessage } from "../../lib/settingsSchema";

interface PromptsTabProps {
  onStatus: (msg: StatusMessage | null) => void;
}

export function PromptsTab({ onStatus }: PromptsTabProps) {
  const savedPrompts = useSettingsStore((s) => s.savedPrompts);
  const observedPrompts = useSettingsStore((s) => s.observedPrompts);
  const addSavedPrompt = useSettingsStore((s) => s.addSavedPrompt);
  const updateSavedPrompt = useSettingsStore((s) => s.updateSavedPrompt);
  const removeSavedPrompt = useSettingsStore((s) => s.removeSavedPrompt);

  const [selectedType, setSelectedType] = useState<"saved" | "observed" | "none">("none");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load selected prompt into editor
  useEffect(() => {
    if (selectedType === "none" || !selectedId) {
      setEditName(""); setEditText(""); setDirty(false);
      return;
    }
    if (selectedType === "saved") {
      const prompt = savedPrompts.find((p) => p.id === selectedId);
      if (prompt) {
        setEditName(prompt.name); setEditText(prompt.text); setDirty(false);
      } else {
        setSelectedType("none"); setSelectedId(null);
      }
    } else {
      const prompt = observedPrompts.find((p) => p.id === selectedId);
      if (prompt) {
        setEditName(""); setEditText(prompt.text); setDirty(false);
      } else {
        setSelectedType("none"); setSelectedId(null);
      }
    }
  }, [selectedType, selectedId, savedPrompts, observedPrompts]);

  const handleSave = useCallback(() => {
    if (selectedType !== "saved" || !selectedId || !dirty) return;
    updateSavedPrompt(selectedId, { name: editName, text: editText });
    setDirty(false);
    onStatus({ type: "success", text: "Prompt saved" });
    setTimeout(() => onStatus(null), 2000);
  }, [selectedType, selectedId, dirty, editName, editText, updateSavedPrompt, onStatus]);

  const handleAdd = useCallback(() => {
    addSavedPrompt("New Prompt", "");
    const newest = useSettingsStore.getState().savedPrompts;
    const last = newest[newest.length - 1];
    if (last) { setSelectedType("saved"); setSelectedId(last.id); }
  }, [addSavedPrompt]);

  const handleDelete = useCallback(() => {
    if (selectedType !== "saved" || !selectedId) return;
    removeSavedPrompt(selectedId);
    setSelectedType("none"); setSelectedId(null);
  }, [selectedType, selectedId, removeSavedPrompt]);

  // Ctrl+S save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s" && dirty && selectedType === "saved") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, selectedType, handleSave]);

  const select = (type: "saved" | "observed", id: string) => {
    setSelectedType(type); setSelectedId(id);
  };

  return (
    <div className="prompts-tab">
      {/* Sidebar */}
      <div className="prompts-sidebar">
        {/* Top: My Prompts */}
        <div className="prompts-section">
          <div className="prompts-section-header">My Prompts</div>
          <div className="prompts-section-list">
            {savedPrompts.map((p) => (
              <button
                key={p.id}
                className={`prompts-list-item${selectedType === "saved" && selectedId === p.id ? " prompts-list-item-active" : ""}`}
                onClick={() => select("saved", p.id)}
              >
                <span className="prompts-item-name">{p.name || "Untitled"}</span>
                <span className="prompts-item-size">{p.text.length.toLocaleString()} chars</span>
              </button>
            ))}
          </div>
          <button className="prompts-add-btn" onClick={handleAdd}>+ Add Prompt</button>
        </div>

        {/* Bottom: Observed */}
        <div className="prompts-section prompts-section-observed">
          <div className="prompts-section-header">
            Observed
            {observedPrompts.length > 0 && (
              <span className="prompts-observed-count">{observedPrompts.length}</span>
            )}
          </div>
          <div className="prompts-section-list">
            {observedPrompts.length === 0 ? (
              <div className="prompts-observed-empty">No prompts captured yet</div>
            ) : (
              observedPrompts.map((p) => (
                <button
                  key={p.id}
                  className={`prompts-list-item${selectedType === "observed" && selectedId === p.id ? " prompts-list-item-active" : ""}`}
                  onClick={() => select("observed", p.id)}
                >
                  <span className="prompts-item-name">{p.label}</span>
                  <span className="prompts-item-size">{p.model} / {p.text.length.toLocaleString()}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Editor */}
      <div className="prompts-editor">
        {selectedType === "none" ? (
          <div className="prompts-empty">
            Select a prompt from the sidebar, or add a new one.
          </div>
        ) : selectedType === "observed" ? (
          <>
            <div className="prompts-editor-header">
              <span className="prompts-editor-title">Observed System Prompt</span>
              <span className="prompts-editor-badge">read-only</span>
            </div>
            <textarea
              className="prompts-textarea"
              value={editText}
              readOnly
              ref={textareaRef}
            />
            <div className="prompts-editor-footer">
              <span className="prompts-char-count">
                {editText.length.toLocaleString()} characters
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="prompts-editor-header">
              <input
                className="prompts-name-input"
                value={editName}
                onChange={(e) => { setEditName(e.target.value); setDirty(true); }}
                placeholder="Prompt name"
                spellCheck={false}
              />
              <div className="prompts-editor-actions">
                {dirty && (
                  <button className="prompts-save-btn" onClick={handleSave}>
                    Save
                  </button>
                )}
                <button className="prompts-delete-btn" onClick={handleDelete} title="Delete prompt">
                  <IconClose size={12} />
                </button>
              </div>
            </div>
            <textarea
              className="prompts-textarea"
              value={editText}
              onChange={(e) => { setEditText(e.target.value); setDirty(true); }}
              ref={textareaRef}
              placeholder="Enter your system prompt..."
              spellCheck={false}
            />
            <div className="prompts-editor-footer">
              <span className="prompts-char-count">
                {editText.length.toLocaleString()} characters
              </span>
              {dirty && <span className="prompts-unsaved">unsaved</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
