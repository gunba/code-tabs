import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSettingsStore } from "../../store/settings";
import { PillGroup } from "../PillGroup/PillGroup";
import { IconClose } from "../Icons/Icons";
import { diffLines, applyRulesToText, generateRulesFromDiff, classifyRule } from "../../lib/promptDiff";
import type { DiffLine } from "../../lib/promptDiff";
import type { SystemPromptRule } from "../../types/session";
import type { StatusMessage } from "../../lib/settingsSchema";
import "./PromptsTab.css";

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

/** Render a line-level diff with inline colored spans (no +/- markers). */
function InlineDiffView({ diff }: { diff: DiffLine[] }) {
  const hasChanges = diff.some((l) => l.type !== "same");
  if (!hasChanges) {
    return <div className="prompts-diff-empty">No changes from original prompt</div>;
  }
  return (
    <pre className="prompts-inline-diff">
      {diff.map((line, i) => {
        if (line.type === "del") {
          return (
            <span key={i} className="prompts-inline-del">
              {line.text}{"\n"}
            </span>
          );
        }
        if (line.type === "add") {
          return (
            <span key={i} className="prompts-inline-add">
              {line.text}{"\n"}
            </span>
          );
        }
        return <span key={i}>{line.text}{"\n"}</span>;
      })}
    </pre>
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

/** Expanded editing area for a single rule card. Local state, save-on-demand. */
function RuleCardExpanded({
  rule,
  onSave,
}: {
  rule: SystemPromptRule;
  onSave: (id: string, updates: Partial<SystemPromptRule>) => void;
}) {
  const [name, setName] = useState(rule.name);
  const [pattern, setPattern] = useState(rule.pattern);
  const [replacement, setReplacement] = useState(rule.replacement);
  const [flags, setFlags] = useState(rule.flags);

  const patternError = validatePattern(pattern, flags);
  const isDirty = name !== rule.name || pattern !== rule.pattern ||
    replacement !== rule.replacement || flags !== rule.flags;

  const doSave = useCallback(() => {
    if (patternError || !isDirty) return;
    onSave(rule.id, { name, pattern, replacement, flags });
  }, [rule.id, name, pattern, replacement, flags, patternError, isDirty, onSave]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        if (isDirty && !patternError) {
          e.preventDefault();
          doSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, patternError, doSave]);

  return (
    <div className="prompts-rule-card-body" onClick={(e) => e.stopPropagation()}>
      <label className="prompts-rule-field">
        <span className="prompts-rule-label">Name</span>
        <input
          className="prompts-rule-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rule name"
          spellCheck={false}
        />
      </label>
      <label className="prompts-rule-field">
        <span className="prompts-rule-label">Pattern</span>
        <input
          className={`prompts-rule-input${patternError ? " prompts-rule-input-error" : ""}`}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="Regex pattern (e.g. Claude)"
          spellCheck={false}
        />
        {patternError && <span className="prompts-rule-error">{patternError}</span>}
      </label>
      <label className="prompts-rule-field">
        <span className="prompts-rule-label">Replacement</span>
        <input
          className="prompts-rule-input"
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          placeholder="Replacement text (e.g. Assistant, supports $1)"
          spellCheck={false}
        />
      </label>
      <div className="prompts-rule-card-save-row">
        <label className="prompts-rule-field prompts-rule-field-flags">
          <span className="prompts-rule-label">Flags</span>
          <input
            className="prompts-rule-input prompts-rule-flags-input"
            value={flags}
            onChange={(e) => setFlags(e.target.value)}
            placeholder="g"
            spellCheck={false}
          />
        </label>
        {isDirty && (
          <button className="prompts-save-btn" onClick={doSave} disabled={!!patternError}>
            Save
          </button>
        )}
        {isDirty && <span className="prompts-unsaved">unsaved</span>}
      </div>
    </div>
  );
}

// [CM-28] PromptsTab splits My Prompts, Observed Prompts, and Rules into separate subtabs; the observed editor can show a live diff while rules stay standalone.
const SUB_TABS: { value: "prompts" | "observed" | "rules"; label: string }[] = [
  { value: "prompts", label: "My Prompts" },
  { value: "observed", label: "Observed Prompts" },
  { value: "rules", label: "Rules" },
];

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

  // Sub-tab navigation
  const [activeSubTab, setActiveSubTab] = useState<"prompts" | "observed" | "rules">("prompts");

  // My Prompts state
  const [selectedSavedPromptId, setSelectedSavedPromptId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Rules sub-tab state
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [selectedObservedPromptId, setSelectedObservedPromptId] = useState<string | null>(null);

  // Observed prompt edit state
  const [observedEditText, setObservedEditText] = useState("");
  const [pendingRules, setPendingRules] = useState<SystemPromptRule[] | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editBaseline, setEditBaseline] = useState("");

  // Collapse expanded rule on tab switch
  useEffect(() => { setExpandedRuleId(null); }, [activeSubTab]);

  // Load saved prompt into editor
  useEffect(() => {
    if (!selectedSavedPromptId) {
      setEditName(""); setEditText(""); setDirty(false);
      return;
    }
    const prompt = savedPrompts.find((p) => p.id === selectedSavedPromptId);
    if (prompt) {
      setEditName(prompt.name); setEditText(prompt.text); setDirty(false);
    } else {
      setSelectedSavedPromptId(null);
    }
  }, [selectedSavedPromptId, savedPrompts]);

  // Reset observed editing state on selection change
  useEffect(() => {
    setPendingRules(null); setIsEditing(false); setEditBaseline("");
  }, [selectedObservedPromptId]);

  // Derive observed prompt data — self-heal if selected prompt aged out
  const selectedObservedPrompt = observedPrompts.find((p) => p.id === selectedObservedPromptId);
  useEffect(() => {
    if (selectedObservedPromptId && !selectedObservedPrompt) {
      setSelectedObservedPromptId(null);
    }
  }, [selectedObservedPromptId, selectedObservedPrompt]);
  const observedRawText = selectedObservedPrompt?.text ?? "";

  // [CM-26] PromptsTab previews observed prompt changes and generates candidate rules via promptDiff helpers.
  // Rules-applied text
  const rulesAppliedText = useMemo(() => {
    if (!observedRawText) return "";
    const enabledRules = systemPromptRules.filter((r) => r.enabled && r.pattern);
    if (enabledRules.length === 0) return observedRawText;
    return applyRulesToText(observedRawText, enabledRules);
  }, [observedRawText, systemPromptRules]);

  // Compute rules-applied text for an arbitrary prompt (used in click handler to avoid stale state flash)
  const computeAppliedText = useCallback((rawText: string): string => {
    if (!rawText) return "";
    const enabledRules = systemPromptRules.filter((r) => r.enabled && r.pattern);
    if (enabledRules.length === 0) return rawText;
    return applyRulesToText(rawText, enabledRules);
  }, [systemPromptRules]);

  // Sync observedEditText when not editing; dismiss stale pending rules when baseline shifts
  useEffect(() => {
    if (selectedObservedPromptId && !isEditing) {
      setObservedEditText(rulesAppliedText);
      setEditBaseline(rulesAppliedText);
    }
    setPendingRules(null);
  }, [selectedObservedPromptId, rulesAppliedText, isEditing]);

  // Diff: original → current state
  const observedDiff = useMemo((): DiffLine[] | null => {
    if (!observedRawText || observedRawText === observedEditText) return null;
    return diffLines(observedRawText, observedEditText);
  }, [observedRawText, observedEditText]);

  const observedEdited = !!selectedObservedPromptId && observedEditText !== rulesAppliedText;

  // ── Saved prompt handlers ──────────────────────────────────────────

  const handleSave = useCallback(() => {
    if (!selectedSavedPromptId || !dirty) return;
    updateSavedPrompt(selectedSavedPromptId, { name: editName, text: editText });
    setDirty(false);
    onStatus({ type: "success", text: "Prompt saved" });
    setTimeout(() => onStatus(null), 2000);
  }, [selectedSavedPromptId, dirty, editName, editText, updateSavedPrompt, onStatus]);

  const handleAdd = useCallback(() => {
    addSavedPrompt("New Prompt", "");
    const newest = useSettingsStore.getState().savedPrompts;
    const last = newest[newest.length - 1];
    if (last) setSelectedSavedPromptId(last.id);
  }, [addSavedPrompt]);

  const handleDelete = useCallback(() => {
    if (!selectedSavedPromptId) return;
    removeSavedPrompt(selectedSavedPromptId);
    setSelectedSavedPromptId(null);
  }, [selectedSavedPromptId, removeSavedPrompt]);

  // ── Rule handlers ──────────────────────────────────────────────────

  const handleRuleSave = useCallback((id: string, updates: Partial<SystemPromptRule>) => {
    updateSystemPromptRule(id, updates);
    onStatus({ type: "success", text: "Rule saved" });
    setTimeout(() => onStatus(null), 2000);
  }, [updateSystemPromptRule, onStatus]);

  const handleRuleDelete = useCallback((id: string) => {
    removeSystemPromptRule(id);
    if (expandedRuleId === id) setExpandedRuleId(null);
  }, [removeSystemPromptRule, expandedRuleId]);

  const handleAddRule = useCallback(() => {
    addSystemPromptRule();
    const newest = useSettingsStore.getState().systemPromptRules;
    const last = newest[newest.length - 1];
    if (last) setExpandedRuleId(last.id);
  }, [addSystemPromptRule]);

  // ── Observed prompt handlers ───────────────────────────────────────

  const handleGenerateRules = useCallback(() => {
    if (!observedEdited) return;
    const generated = generateRulesFromDiff(rulesAppliedText, observedEditText, systemPromptRules);
    if (generated.length === 0) {
      onStatus({ type: "error", text: "No rules could be generated from these changes" });
      setTimeout(() => onStatus(null), 3000);
      return;
    }
    setPendingRules(generated);
  }, [observedEdited, rulesAppliedText, observedEditText, systemPromptRules, onStatus]);

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
    setIsEditing(false);
    onStatus({ type: "success", text: `${pendingRules.length} rule${pendingRules.length !== 1 ? "s" : ""} added (disabled)` });
    setTimeout(() => onStatus(null), 3000);
  }, [pendingRules, onStatus]);

  const handleStartEditing = useCallback(() => {
    setEditBaseline(rulesAppliedText);
    setObservedEditText(rulesAppliedText);
    setIsEditing(true);
  }, [rulesAppliedText]);

  const handleDoneEditing = useCallback(() => {
    setIsEditing(false);
    if (observedEditText === editBaseline) {
      setObservedEditText(rulesAppliedText);
    }
  }, [observedEditText, editBaseline, rulesAppliedText]);

  // Ctrl+S for saved prompts only
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        if (dirty && activeSubTab === "prompts") {
          e.preventDefault();
          handleSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, activeSubTab, handleSave]);

  return (
    <div className="prompts-tab">
      <div className="prompts-subtab-bar">
        <PillGroup
          options={SUB_TABS}
          selected={activeSubTab}
          onChange={(v) => v && setActiveSubTab(v)}
        />
      </div>

      {activeSubTab === "prompts" ? (
        /* ── My Prompts sub-tab ─────────────────────────────────────── */
        <div className="prompts-myprompts-layout">
          <div className="prompts-myprompts-sidebar">
            <div className="prompts-section-header">My Prompts</div>
            <div className="prompts-section-list">
              {savedPrompts.map((p) => (
                <button
                  key={p.id}
                  className={`prompts-list-item${selectedSavedPromptId === p.id ? " prompts-list-item-active" : ""}`}
                  onClick={() => setSelectedSavedPromptId(p.id)}
                >
                  <span className="prompts-item-name">{p.name || "Untitled"}</span>
                  <span className="prompts-item-size">{p.text.length.toLocaleString()} chars</span>
                </button>
              ))}
            </div>
            <button className="prompts-add-btn" onClick={handleAdd}>+ Add Prompt</button>
          </div>

          <div className="prompts-editor">
            {!selectedSavedPromptId ? (
              <div className="prompts-empty">
                Select a prompt from the sidebar, or add a new one.
              </div>
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
                      <button className="prompts-save-btn" onClick={handleSave}>Save</button>
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
      ) : activeSubTab === "observed" ? (
        /* ── Observed Prompts sub-tab ──────────────────────────────── */
        <div className="prompts-myprompts-layout">
          <div className="prompts-myprompts-sidebar">
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
                    className={`prompts-list-item${selectedObservedPromptId === p.id ? " prompts-list-item-active" : ""}`}
                    onClick={() => {
                      if (p.id === selectedObservedPromptId) return;
                      setSelectedObservedPromptId(p.id);
                      const applied = computeAppliedText(p.text);
                      setObservedEditText(applied);
                      setEditBaseline(applied);
                      setIsEditing(false);
                      setPendingRules(null);
                    }}
                  >
                    <span className="prompts-item-name">{p.label}</span>
                    <span className="prompts-item-size">{p.model} / {p.text.length.toLocaleString()}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="prompts-editor">
            {!selectedObservedPromptId ? (
              <div className="prompts-empty">
                Select an observed prompt from the sidebar to view its diff.
              </div>
            ) : (
              <>
                <div className="prompts-editor-header">
                  <span className="prompts-editor-title">Observed System Prompt</span>
                  <div className="prompts-editor-actions">
                    {observedEdited && !pendingRules && (
                      <button className="prompts-save-btn" onClick={handleGenerateRules}>
                        Generate Rules
                      </button>
                    )}
                    {!pendingRules && (
                      isEditing ? (
                        <button className="prompts-edit-toggle" onClick={handleDoneEditing}>Done</button>
                      ) : (
                        <button className="prompts-edit-toggle" onClick={handleStartEditing}>Edit</button>
                      )
                    )}
                  </div>
                </div>

                <div className="prompts-observed-pane">
                  {pendingRules ? (
                    <RulePreview
                      rules={pendingRules}
                      onConfirm={handleConfirmRules}
                      onCancel={() => setPendingRules(null)}
                    />
                  ) : isEditing ? (
                    <div className="prompts-observed-split">
                      <textarea
                        className="prompts-textarea"
                        value={observedEditText}
                        onChange={(e) => setObservedEditText(e.target.value)}
                        spellCheck={false}
                      />
                      <div className="prompts-observed-split-diff">
                        {observedDiff ? (
                          <InlineDiffView diff={observedDiff} />
                        ) : (
                          <div className="prompts-diff-empty">No changes from original prompt</div>
                        )}
                      </div>
                    </div>
                  ) : observedDiff ? (
                    <InlineDiffView diff={observedDiff} />
                  ) : (
                    <pre className="prompts-inline-diff prompts-inline-diff-plain">{rulesAppliedText}</pre>
                  )}
                </div>

                <div className="prompts-editor-footer">
                  <span className="prompts-char-count">
                    {(isEditing ? observedEditText : observedRawText).length.toLocaleString()} characters
                  </span>
                  {observedEdited && <span className="prompts-unsaved">edited</span>}
                  {isEditing && editBaseline !== rulesAppliedText && (
                    <span className="prompts-unsaved">rules changed</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        /* ── Rules sub-tab ──────────────────────────────────────────── */
        <div className="prompts-rules-panel prompts-rules-standalone">
          <div className="prompts-section-header">
            Prompt Rules
            {systemPromptRules.length > 0 && (
              <span className="prompts-observed-count">
                {systemPromptRules.filter((r) => r.enabled).length}/{systemPromptRules.length}
              </span>
            )}
          </div>

          <div className="prompts-rules-cards">
            {systemPromptRules.length === 0 ? (
              <div className="prompts-observed-empty">No rules created yet</div>
            ) : (
              systemPromptRules.map((rule) => (
                <div
                  key={rule.id}
                  className={`prompts-rule-card${expandedRuleId === rule.id ? " prompts-rule-card-active" : ""}${!rule.enabled ? " prompts-rule-card-disabled" : ""}`}
                >
                  <div
                    className="prompts-rule-card-header"
                    onClick={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}
                  >
                    <input
                      type="checkbox"
                      className="prompts-rule-card-toggle"
                      checked={rule.enabled}
                      onChange={() => updateSystemPromptRule(rule.id, { enabled: !rule.enabled })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {(() => {
                      const info = classifyRule(rule);
                      if (info.type === "remove") {
                        return (
                          <span className="prompts-rule-header-remove">
                            {info.displayLeft || "no pattern"}
                          </span>
                        );
                      }
                      return (
                        <div className="prompts-rule-header-transform">
                          <span className="prompts-rule-header-left">
                            {info.displayLeft || "no pattern"}
                          </span>
                          <span className="prompts-rule-header-arrow">
                            {info.type === "add" ? "+" : "\u2192"}
                          </span>
                          <span className="prompts-rule-header-right">
                            {info.displayRight}
                          </span>
                        </div>
                      );
                    })()}
                    <div className="prompts-rule-card-actions">
                      <button
                        className="prompts-rule-arrow-btn"
                        onClick={(e) => { e.stopPropagation(); reorderSystemPromptRules(rule.id, -1); }}
                        title="Move up"
                      >▲</button>
                      <button
                        className="prompts-rule-arrow-btn"
                        onClick={(e) => { e.stopPropagation(); reorderSystemPromptRules(rule.id, 1); }}
                        title="Move down"
                      >▼</button>
                      <button
                        className="prompts-delete-btn"
                        onClick={(e) => { e.stopPropagation(); handleRuleDelete(rule.id); }}
                        title="Delete rule"
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  </div>
                  {expandedRuleId === rule.id && (
                    <RuleCardExpanded rule={rule} onSave={handleRuleSave} />
                  )}
                </div>
              ))
            )}
          </div>

          <button className="prompts-add-btn" onClick={handleAddRule}>+ Add Rule</button>
        </div>
      )}
    </div>
  );
}
