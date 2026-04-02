import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSettingsStore } from "../../store/settings";
import { IconClose } from "../Icons/Icons";
import { diffLines, applyRulesToText, generateRulesFromDiff } from "../../lib/promptDiff";
import type { DiffLine } from "../../lib/promptDiff";
import type { SystemPromptRule } from "../../types/session";
import type { StatusMessage } from "../../lib/settingsSchema";

interface PromptsTabProps {
  onStatus: (msg: StatusMessage | null) => void;
}

function validatePattern(pattern: string, flags: string): string | null {
  if (!pattern) return null;
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid regex";
  }
}

/** Render a unified diff with colored lines. */
function DiffPreview({ diff }: { diff: DiffLine[] }) {
  const hasChanges = diff.some((l) => l.type !== "same");
  if (!hasChanges) {
    return <div className="prompts-diff-empty">No rules affect this prompt</div>;
  }
  return (
    <div className="prompts-diff-view">
      {diff.map((line, i) => (
        <div key={i} className={`prompts-diff-line prompts-diff-${line.type}`}>
          <span className="prompts-diff-marker">
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          <span className="prompts-diff-text">{line.text || "\u00A0"}</span>
        </div>
      ))}
    </div>
  );
}

/** Preview generated rules before committing. */
function RulePreview({
  rules,
  onConfirm,
  onCancel,
}: {
  rules: SystemPromptRule[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="prompts-rule-preview">
      <div className="prompts-rule-preview-header">
        {rules.length} rule{rules.length !== 1 ? "s" : ""} will be generated (disabled by default):
      </div>
      <div className="prompts-rule-preview-list">
        {rules.map((r) => (
          <div key={r.id} className="prompts-rule-preview-item">
            <div className="prompts-rule-preview-name">{r.name}</div>
            <div className="prompts-rule-preview-detail">
              <span className="prompts-diff-del" style={{ padding: "0 4px" }}>{r.pattern.slice(0, 60)}</span>
              {r.replacement && (
                <>
                  {" → "}
                  <span className="prompts-diff-add" style={{ padding: "0 4px" }}>{r.replacement.slice(0, 60)}</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="prompts-rule-preview-actions">
        <button className="prompts-save-btn" onClick={onConfirm}>Add Rules</button>
        <button className="prompts-delete-btn" onClick={onCancel} style={{ padding: "4px 8px" }}>Cancel</button>
      </div>
    </div>
  );
}

export function PromptsTab({ onStatus }: PromptsTabProps) {
  const savedPrompts = useSettingsStore((s) => s.savedPrompts);
  const observedPrompts = useSettingsStore((s) => s.observedPrompts);
  const addSavedPrompt = useSettingsStore((s) => s.addSavedPrompt);
  const updateSavedPrompt = useSettingsStore((s) => s.updateSavedPrompt);
  const removeSavedPrompt = useSettingsStore((s) => s.removeSavedPrompt);

  const systemPromptRules = useSettingsStore((s) => s.systemPromptRules);
  const addSystemPromptRule = useSettingsStore((s) => s.addSystemPromptRule);
  const updateSystemPromptRule = useSettingsStore((s) => s.updateSystemPromptRule);
  const removeSystemPromptRule = useSettingsStore((s) => s.removeSystemPromptRule);
  const reorderSystemPromptRules = useSettingsStore((s) => s.reorderSystemPromptRules);

  const [selectedType, setSelectedType] = useState<"saved" | "observed" | "rules" | "none">("none");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Rule editor state
  const [editPattern, setEditPattern] = useState("");
  const [editReplacement, setEditReplacement] = useState("");
  const [editFlags, setEditFlags] = useState("g");
  const [editEnabled, setEditEnabled] = useState(true);
  const [ruleDirty, setRuleDirty] = useState(false);

  // Observed prompt edit state (for rule generation)
  const [observedEditText, setObservedEditText] = useState("");
  const [pendingRules, setPendingRules] = useState<SystemPromptRule[] | null>(null);

  // Load selected prompt into editor
  useEffect(() => {
    if (selectedType === "none" || !selectedId) {
      setEditName(""); setEditText(""); setDirty(false);
      setEditPattern(""); setEditReplacement(""); setEditFlags("g"); setEditEnabled(true); setRuleDirty(false);
      setObservedEditText(""); setPendingRules(null);
      return;
    }
    if (selectedType === "saved") {
      const prompt = savedPrompts.find((p) => p.id === selectedId);
      if (prompt) {
        setEditName(prompt.name); setEditText(prompt.text); setDirty(false);
      } else {
        setSelectedType("none"); setSelectedId(null);
      }
    } else if (selectedType === "observed") {
      const prompt = observedPrompts.find((p) => p.id === selectedId);
      if (prompt) {
        setEditName(""); setEditText(prompt.text); setDirty(false);
        setObservedEditText(prompt.text); setPendingRules(null);
      } else {
        setSelectedType("none"); setSelectedId(null);
      }
    } else if (selectedType === "rules") {
      const rule = systemPromptRules.find((r) => r.id === selectedId);
      if (rule) {
        setEditName(rule.name); setEditPattern(rule.pattern);
        setEditReplacement(rule.replacement); setEditFlags(rule.flags);
        setEditEnabled(rule.enabled); setRuleDirty(false);
      } else {
        setSelectedType("none"); setSelectedId(null);
      }
    }
  }, [selectedType, selectedId, savedPrompts, observedPrompts, systemPromptRules]);

  // Compute diff preview for observed prompts (shows effect of current rules)
  const observedDiff = useMemo((): DiffLine[] | null => {
    if (selectedType !== "observed" || !editText) return null;
    const enabledRules = systemPromptRules.filter((r) => r.enabled && r.pattern);
    if (enabledRules.length === 0) return null;
    const transformed = applyRulesToText(editText, enabledRules);
    return diffLines(editText, transformed);
  }, [selectedType, editText, systemPromptRules]);

  // Check if observed edit differs from original
  const observedEdited = selectedType === "observed" && observedEditText !== editText;

  const handleSave = useCallback(() => {
    if (selectedType !== "saved" || !selectedId || !dirty) return;
    updateSavedPrompt(selectedId, { name: editName, text: editText });
    setDirty(false);
    onStatus({ type: "success", text: "Prompt saved" });
    setTimeout(() => onStatus(null), 2000);
  }, [selectedType, selectedId, dirty, editName, editText, updateSavedPrompt, onStatus]);

  const handleRuleSave = useCallback(() => {
    if (selectedType !== "rules" || !selectedId || !ruleDirty) return;
    updateSystemPromptRule(selectedId, {
      name: editName, pattern: editPattern, replacement: editReplacement,
      flags: editFlags, enabled: editEnabled,
    });
    setRuleDirty(false);
    onStatus({ type: "success", text: "Rule saved" });
    setTimeout(() => onStatus(null), 2000);
  }, [selectedType, selectedId, ruleDirty, editName, editPattern, editReplacement, editFlags, editEnabled, updateSystemPromptRule, onStatus]);

  const handleGenerateRules = useCallback(() => {
    if (selectedType !== "observed" || !observedEdited) return;
    const generated = generateRulesFromDiff(editText, observedEditText, systemPromptRules);
    if (generated.length === 0) {
      onStatus({ type: "error", text: "No rules could be generated from these changes" });
      setTimeout(() => onStatus(null), 3000);
      return;
    }
    setPendingRules(generated);
  }, [selectedType, observedEdited, editText, observedEditText, systemPromptRules, onStatus]);

  const handleConfirmRules = useCallback(() => {
    if (!pendingRules) return;
    const store = useSettingsStore.getState();
    for (const rule of pendingRules) {
      store.addSystemPromptRule();
      const newest = useSettingsStore.getState().systemPromptRules;
      const last = newest[newest.length - 1];
      if (last) {
        store.updateSystemPromptRule(last.id, {
          name: rule.name,
          pattern: rule.pattern,
          replacement: rule.replacement,
          flags: rule.flags,
          enabled: false,
        });
      }
    }
    setPendingRules(null);
    setObservedEditText(editText); // Reset edit state
    onStatus({ type: "success", text: `${pendingRules.length} rule${pendingRules.length !== 1 ? "s" : ""} added (disabled)` });
    setTimeout(() => onStatus(null), 3000);
  }, [pendingRules, editText, onStatus]);

  const handleAdd = useCallback(() => {
    addSavedPrompt("New Prompt", "");
    const newest = useSettingsStore.getState().savedPrompts;
    const last = newest[newest.length - 1];
    if (last) { setSelectedType("saved"); setSelectedId(last.id); }
  }, [addSavedPrompt]);

  const handleAddRule = useCallback(() => {
    addSystemPromptRule();
    const newest = useSettingsStore.getState().systemPromptRules;
    const last = newest[newest.length - 1];
    if (last) { setSelectedType("rules"); setSelectedId(last.id); }
  }, [addSystemPromptRule]);

  const handleDelete = useCallback(() => {
    if (selectedType !== "saved" || !selectedId) return;
    removeSavedPrompt(selectedId);
    setSelectedType("none"); setSelectedId(null);
  }, [selectedType, selectedId, removeSavedPrompt]);

  const handleRuleDelete = useCallback(() => {
    if (selectedType !== "rules" || !selectedId) return;
    removeSystemPromptRule(selectedId);
    setSelectedType("none"); setSelectedId(null);
  }, [selectedType, selectedId, removeSystemPromptRule]);

  // Ctrl+S save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        if (dirty && selectedType === "saved") {
          e.preventDefault();
          handleSave();
        } else if (ruleDirty && selectedType === "rules") {
          e.preventDefault();
          handleRuleSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, ruleDirty, selectedType, handleSave, handleRuleSave]);

  const select = (type: "saved" | "observed" | "rules", id: string) => {
    setSelectedType(type); setSelectedId(id);
  };

  const patternError = validatePattern(editPattern, editFlags);

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

        {/* Middle: Prompt Rules */}
        <div className="prompts-section prompts-section-rules">
          <div className="prompts-section-header">
            Prompt Rules
            {systemPromptRules.length > 0 && (
              <span className="prompts-observed-count">{systemPromptRules.filter((r) => r.enabled).length}/{systemPromptRules.length}</span>
            )}
          </div>
          <div className="prompts-section-list">
            {systemPromptRules.map((r) => (
              <button
                key={r.id}
                className={`prompts-list-item${selectedType === "rules" && selectedId === r.id ? " prompts-list-item-active" : ""}${!r.enabled ? " prompts-list-item-disabled" : ""}`}
                onClick={() => select("rules", r.id)}
              >
                <span className="prompts-item-name">{r.name || "Untitled"}</span>
                <span className="prompts-item-size">
                  {r.pattern ? (r.pattern.length > 30 ? r.pattern.slice(0, 30) + "..." : r.pattern) : "no pattern"}
                </span>
              </button>
            ))}
          </div>
          <button className="prompts-add-btn" onClick={handleAddRule}>+ Add Rule</button>
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
              <span className="prompts-editor-badge">test case</span>
            </div>

            {/* Diff preview: shows what current rules would do */}
            <div className="prompts-observed-split">
              <div className="prompts-diff-section">
                <div className="prompts-diff-header">Rule Effect Preview</div>
                {observedDiff ? (
                  <DiffPreview diff={observedDiff} />
                ) : (
                  <div className="prompts-diff-empty">No enabled rules to preview</div>
                )}
              </div>

              {/* Edit area for generating new rules */}
              <div className="prompts-edit-section">
                <div className="prompts-diff-header">
                  Edit to Generate Rules
                  {observedEdited && !pendingRules && (
                    <button className="prompts-save-btn" onClick={handleGenerateRules}>
                      Generate Rules
                    </button>
                  )}
                </div>
                {pendingRules ? (
                  <RulePreview
                    rules={pendingRules}
                    onConfirm={handleConfirmRules}
                    onCancel={() => setPendingRules(null)}
                  />
                ) : (
                  <textarea
                    className="prompts-textarea"
                    value={observedEditText}
                    onChange={(e) => setObservedEditText(e.target.value)}
                    ref={textareaRef}
                    spellCheck={false}
                  />
                )}
              </div>
            </div>

            <div className="prompts-editor-footer">
              <span className="prompts-char-count">
                {editText.length.toLocaleString()} characters
              </span>
              {observedEdited && <span className="prompts-unsaved">edited</span>}
            </div>
          </>
        ) : selectedType === "rules" ? (
          <>
            <div className="prompts-editor-header">
              <input
                className="prompts-name-input"
                value={editName}
                onChange={(e) => { setEditName(e.target.value); setRuleDirty(true); }}
                placeholder="Rule name"
                spellCheck={false}
              />
              <div className="prompts-editor-actions">
                {ruleDirty && !patternError && (
                  <button className="prompts-save-btn" onClick={handleRuleSave}>
                    Save
                  </button>
                )}
                <button className="prompts-delete-btn" onClick={handleRuleDelete} title="Delete rule">
                  <IconClose size={12} />
                </button>
              </div>
            </div>
            <div className="prompts-rule-fields">
              <label className="prompts-rule-field">
                <span className="prompts-rule-label">Pattern</span>
                <input
                  className={`prompts-rule-input${patternError ? " prompts-rule-input-error" : ""}`}
                  value={editPattern}
                  onChange={(e) => { setEditPattern(e.target.value); setRuleDirty(true); }}
                  placeholder="Regex pattern (e.g. Claude)"
                  spellCheck={false}
                />
                {patternError && <span className="prompts-rule-error">{patternError}</span>}
              </label>
              <label className="prompts-rule-field">
                <span className="prompts-rule-label">Replacement</span>
                <input
                  className="prompts-rule-input"
                  value={editReplacement}
                  onChange={(e) => { setEditReplacement(e.target.value); setRuleDirty(true); }}
                  placeholder="Replacement text (e.g. Assistant, supports $1)"
                  spellCheck={false}
                />
              </label>
              <div className="prompts-rule-row">
                <label className="prompts-rule-field prompts-rule-field-flags">
                  <span className="prompts-rule-label">Flags</span>
                  <input
                    className="prompts-rule-input prompts-rule-flags-input"
                    value={editFlags}
                    onChange={(e) => { setEditFlags(e.target.value); setRuleDirty(true); }}
                    placeholder="g"
                    spellCheck={false}
                  />
                </label>
                <label className="prompts-rule-toggle">
                  <input
                    type="checkbox"
                    checked={editEnabled}
                    onChange={(e) => { setEditEnabled(e.target.checked); setRuleDirty(true); }}
                  />
                  <span>Enabled</span>
                </label>
                <div className="prompts-rule-arrows">
                  <button
                    className="prompts-rule-arrow-btn"
                    onClick={() => selectedId && reorderSystemPromptRules(selectedId, -1)}
                    title="Move up"
                  >▲</button>
                  <button
                    className="prompts-rule-arrow-btn"
                    onClick={() => selectedId && reorderSystemPromptRules(selectedId, 1)}
                    title="Move down"
                  >▼</button>
                </div>
              </div>
            </div>
            <div className="prompts-editor-footer">
              {ruleDirty && <span className="prompts-unsaved">unsaved</span>}
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
