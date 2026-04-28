import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../store/settings";
import { PillGroup } from "../PillGroup/PillGroup";
import { IconClose } from "../Icons/Icons";
import { applyRulesToText, generateRulesAndConflicts, classifyRule } from "../../lib/promptDiff";
import type { GeneratedChangeset } from "../../lib/promptDiff";
import type { CliKind, SystemPromptRule } from "../../types/session";
import type { StatusMessage } from "../../lib/settingsSchema";
import { useUnsavedTextEditor } from "./UnsavedTextEditors";
import "./PromptsTab.css";

interface PromptsTabProps {
  cli: CliKind;
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

/** Preview generated rules (adds + deletes) before committing. */
function RulePreview({
  changeset,
  onConfirm,
  onCancel,
}: {
  changeset: GeneratedChangeset;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { adds, deletes, unresolvedDrift } = changeset;
  const confirmLabel = deletes.length > 0 ? "Apply Changes" : "Add Rules";
  return (
    <div className="prompts-rule-preview">
      {adds.length > 0 && (
        <>
          <div className="prompts-rule-preview-header">
            {adds.length} rule{adds.length !== 1 ? "s" : ""} to add (disabled by default):
          </div>
          <div className="prompts-rule-preview-list">
            {adds.map((r) => (
              <div key={r.id} className="prompts-rule-preview-item">
                <div className="prompts-rule-preview-name">{r.name}</div>
                <div className="prompts-rule-preview-detail">
                  <span className="prompts-diff-del" style={{ padding: "0 4px" }}>{r.pattern.slice(0, 60)}</span>
                  {r.replacement && (
                    <>
                      {" \u2192 "}
                      <span className="prompts-diff-add" style={{ padding: "0 4px" }}>{r.replacement.slice(0, 60)}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {deletes.length > 0 && (
        <>
          <div className="prompts-rule-preview-header">
            {deletes.length} rule{deletes.length !== 1 ? "s" : ""} to remove (would conflict with desired outcome):
          </div>
          <div className="prompts-rule-preview-list">
            {deletes.map((r) => {
              const info = classifyRule(r);
              return (
                <div key={r.id} className="prompts-rule-preview-item prompts-rule-preview-item-delete">
                  <div className="prompts-rule-preview-name">{r.name || "Unnamed rule"}</div>
                  <div className="prompts-rule-preview-detail">
                    <span className="prompts-diff-del" style={{ padding: "0 4px" }}>{info.displayLeft.slice(0, 60)}</span>
                    {info.type !== "remove" && info.displayRight && (
                      <>
                        {" \u2192 "}
                        <span className="prompts-diff-add" style={{ padding: "0 4px" }}>{info.displayRight.slice(0, 60)}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {unresolvedDrift && (
        <div className="prompts-rule-preview-warning">
          Some differences may still require manual rule edits after applying.
        </div>
      )}
      <div className="prompts-rule-preview-actions">
        <button className="prompts-save-btn" onClick={onConfirm}>{confirmLabel}</button>
        <button className="prompts-delete-btn" onClick={onCancel} style={{ padding: "4px 8px" }}>Cancel</button>
      </div>
    </div>
  );
}

function RuleMatchCount({ count }: { count: number }) {
  const never = count === 0;
  const suffix = count === 1 ? "" : "es";
  return (
    <span
      className={`prompts-rule-match-count${never ? " prompts-rule-match-count-zero" : ""}`}
      title={
        never
          ? "This rule has not matched any request this session"
          : `Matched ${count} request${count === 1 ? "" : "s"} this session`
      }
    >
      {never ? "never fired" : `${count} match${suffix}`}
    </span>
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
          // Uncontrolled: defaultValue seeds on mount, onInput keeps local
          // state in sync without React writing back to the DOM (which would
          // wipe native undo). RuleCardExpanded only mounts when a rule
          // expands, so the rule prop is the seed.
          className="prompts-rule-input"
          defaultValue={rule.name}
          onInput={(e) => setName(e.currentTarget.value)}
          placeholder="Rule name"
          spellCheck={false}
        />
      </label>
      <label className="prompts-rule-field">
        <span className="prompts-rule-label">Pattern</span>
        <input
          className={`prompts-rule-input${patternError ? " prompts-rule-input-error" : ""}`}
          defaultValue={rule.pattern}
          onInput={(e) => setPattern(e.currentTarget.value)}
          placeholder="Regex pattern (e.g. Claude)"
          spellCheck={false}
        />
        {patternError && <span className="prompts-rule-error">{patternError}</span>}
      </label>
      <label className="prompts-rule-field">
        <span className="prompts-rule-label">Replacement</span>
        <input
          className="prompts-rule-input"
          defaultValue={rule.replacement}
          onInput={(e) => setReplacement(e.currentTarget.value)}
          placeholder="Replacement text (e.g. Assistant, supports $1)"
          spellCheck={false}
        />
      </label>
      <div className="prompts-rule-card-save-row">
        <label className="prompts-rule-field prompts-rule-field-flags">
          <span className="prompts-rule-label">Flags</span>
          <input
            className="prompts-rule-input prompts-rule-flags-input"
            defaultValue={rule.flags}
            onInput={(e) => setFlags(e.currentTarget.value)}
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

// [CM-28] PromptsTab splits My Prompts, Observed Prompts, and Rules into separate subtabs; observed pane is a single always-editable textarea with observedBaseline tracking; RulePreview pane replaces it during pending-rules preview.
const SUB_TABS: { value: "prompts" | "observed" | "rules"; label: string }[] = [
  { value: "prompts", label: "My Prompts" },
  { value: "observed", label: "Observed Prompts" },
  { value: "rules", label: "Rules" },
];

export function PromptsTab({ cli, onStatus }: PromptsTabProps) {
  const savedPrompts = useSettingsStore((s) => s.savedPrompts);
  const allObservedPrompts = useSettingsStore((s) => s.observedPrompts);
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
  const supportsPromptRules = true;
  const availableSubTabs = useMemo(() => SUB_TABS, []);

  // My Prompts state
  const [selectedSavedPromptId, setSelectedSavedPromptId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [savedSeedKey, setSavedSeedKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Mirror editText/editName into refs so the seed-on-prompt-change effect can
  // compare against the live values without re-running on every keystroke.
  const editTextRef = useRef("");
  editTextRef.current = editText;
  const editNameRef = useRef("");
  editNameRef.current = editName;

  // Rules sub-tab state
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [selectedObservedPromptId, setSelectedObservedPromptId] = useState<string | null>(null);
  const [ruleMatchCounts, setRuleMatchCounts] = useState<Record<string, number>>({});

  // Observed prompt edit state
  const [observedEditText, setObservedEditText] = useState("");
  const [observedBaseline, setObservedBaseline] = useState("");
  const [pendingRules, setPendingRules] = useState<GeneratedChangeset | null>(null);
  const [observedSeedKey, setObservedSeedKey] = useState(0);
  const observedTextareaRef = useRef<HTMLTextAreaElement>(null);
  const observedPrompts = useMemo(
    () => allObservedPrompts.filter((p) => (p.cli ?? "claude") === cli),
    [allObservedPrompts, cli],
  );

  // Collapse expanded rule on tab switch
  useEffect(() => { setExpandedRuleId(null); }, [activeSubTab]);

  useEffect(() => {
    if (activeSubTab !== "rules") return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    invoke<Record<string, number>>("get_rule_match_counts")
      .then((counts) => { if (!disposed) setRuleMatchCounts(counts); })
      .catch(() => {});

    listen<Record<string, number>>("rule_match_counts", (event) => {
      if (!disposed) setRuleMatchCounts(event.payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeSubTab]);

  // Load saved prompt into editor. We only reseed (bump seedKey + remount the
  // inputs) when the underlying values genuinely differ from what's currently
  // being edited — that way an after-save savedPrompts update doesn't tear
  // down the inputs and wipe their native undo stack.
  useEffect(() => {
    if (!selectedSavedPromptId) {
      setEditName("");
      setEditText("");
      setDirty(false);
      setSavedSeedKey((k) => k + 1);
      return;
    }
    const prompt = savedPrompts.find((p) => p.id === selectedSavedPromptId);
    if (prompt) {
      const needsReseed =
        prompt.text !== editTextRef.current || prompt.name !== editNameRef.current;
      if (needsReseed) {
        setEditName(prompt.name);
        setEditText(prompt.text);
        setSavedSeedKey((k) => k + 1);
      }
      setDirty(false);
    } else {
      setSelectedSavedPromptId(null);
    }
  }, [selectedSavedPromptId, savedPrompts]);

  // Reset observed editing state on selection change. Seeding observedEditText happens in the sidebar click handler; this effect clears state when nothing is selected.
  useEffect(() => {
    setPendingRules(null);
    if (!selectedObservedPromptId) {
      setObservedEditText("");
      setObservedBaseline("");
    }
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
    if (!supportsPromptRules) return observedRawText;
    const enabledRules = systemPromptRules.filter((r) => r.enabled && r.pattern);
    if (enabledRules.length === 0) return observedRawText;
    return applyRulesToText(observedRawText, enabledRules);
  }, [observedRawText, supportsPromptRules, systemPromptRules]);

  // Compute rules-applied text for an arbitrary prompt (used in click handler to avoid stale state flash)
  const computeAppliedText = useCallback((rawText: string): string => {
    if (!rawText) return "";
    if (!supportsPromptRules) return rawText;
    const enabledRules = systemPromptRules.filter((r) => r.enabled && r.pattern);
    if (enabledRules.length === 0) return rawText;
    return applyRulesToText(rawText, enabledRules);
  }, [supportsPromptRules, systemPromptRules]);

  // Reseed textarea when rules change out from under the user, but only if they haven't typed anything different from the last seeded baseline (and no preview is open).
  useEffect(() => {
    if (!selectedObservedPromptId) return;
    if (pendingRules) return;
    if (observedEditText !== observedBaseline) return;
    if (rulesAppliedText === observedBaseline) return;
    setObservedEditText(rulesAppliedText);
    setObservedBaseline(rulesAppliedText);
    setObservedSeedKey((k) => k + 1);
  }, [rulesAppliedText, selectedObservedPromptId, pendingRules, observedEditText, observedBaseline]);

  const observedEdited = !!selectedObservedPromptId && observedEditText !== observedBaseline;

  useUnsavedTextEditor(`prompt:saved:${selectedSavedPromptId ?? "none"}`, () => {
    if (activeSubTab !== "prompts" || !selectedSavedPromptId) return null;
    const prompt = savedPrompts.find((p) => p.id === selectedSavedPromptId);
    if (!prompt) return null;
    const after = textareaRef.current?.value ?? editText;
    if (after === prompt.text) return null;
    return {
      title: `Prompt "${prompt.name || "Untitled"}"`,
      before: prompt.text,
      after,
    };
  });

  useUnsavedTextEditor(`prompt:observed:${cli}:${selectedObservedPromptId ?? "none"}`, () => {
    if (activeSubTab !== "observed" || !selectedObservedPromptId) return null;
    const after = observedTextareaRef.current?.value ?? observedEditText;
    if (after === observedBaseline) return null;
    return {
      title: `${cli === "codex" ? "Observed Codex instructions" : "Observed system prompt"}${selectedObservedPrompt?.label ? ` (${selectedObservedPrompt.label})` : ""}`,
      before: observedBaseline,
      after,
    };
  });

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
    if (!supportsPromptRules) return;
    if (!observedEdited) return;
    const changeset = generateRulesAndConflicts(observedRawText, observedEditText, systemPromptRules);
    if (changeset.adds.length === 0 && changeset.deletes.length === 0) {
      onStatus({ type: "error", text: "No rules could be generated from these changes" });
      setTimeout(() => onStatus(null), 3000);
      return;
    }
    setPendingRules(changeset);
  }, [supportsPromptRules, observedEdited, observedRawText, observedEditText, systemPromptRules, onStatus]);

  const handleConfirmRules = useCallback(() => {
    if (!pendingRules) return;
    const store = useSettingsStore.getState();
    for (const rule of pendingRules.deletes) {
      store.removeSystemPromptRule(rule.id);
    }
    for (const rule of pendingRules.adds) {
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
    const addCount = pendingRules.adds.length;
    const delCount = pendingRules.deletes.length;
    const parts: string[] = [];
    if (addCount > 0) parts.push(`${addCount} rule${addCount !== 1 ? "s" : ""} added`);
    if (delCount > 0) parts.push(`${delCount} rule${delCount !== 1 ? "s" : ""} removed`);
    setObservedBaseline(observedEditText);
    setPendingRules(null);
    onStatus({ type: "success", text: parts.join(", ") });
    setTimeout(() => onStatus(null), 3000);
  }, [pendingRules, observedEditText, onStatus]);

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
          options={availableSubTabs}
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
                    // Uncontrolled: defaultValue + onInput. Remount via the
                    // savedSeedKey when an external selection / external edit
                    // changes the seed value, so the browser's undo stack is
                    // never wiped by a React-driven value reset.
                    key={`name-${savedSeedKey}`}
                    className="prompts-name-input"
                    defaultValue={editName}
                    onInput={(e) => { setEditName(e.currentTarget.value); setDirty(true); }}
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
                  key={`text-${savedSeedKey}`}
                  className="prompts-textarea"
                  defaultValue={editText}
                  onInput={(e) => { setEditText(e.currentTarget.value); setDirty(true); }}
                  ref={textareaRef}
                  placeholder={cli === "codex" ? "Enter reusable Codex instructions..." : "Enter your system prompt..."}
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
                      setObservedBaseline(applied);
                      setObservedSeedKey((k) => k + 1);
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
                Select an observed prompt from the sidebar to edit it.
              </div>
            ) : (
              <>
                <div className="prompts-editor-header">
                  <span className="prompts-editor-title">{cli === "codex" ? "Observed Codex Instructions" : "Observed System Prompt"}</span>
                  <div className="prompts-editor-actions">
                    {supportsPromptRules && observedEdited && !pendingRules && (
                      <button className="prompts-save-btn" onClick={handleGenerateRules}>
                        Generate Rules
                      </button>
                    )}
                  </div>
                </div>

                <div className="prompts-observed-pane">
                  {pendingRules ? (
                    <RulePreview
                      changeset={pendingRules}
                      onConfirm={handleConfirmRules}
                      onCancel={() => setPendingRules(null)}
                    />
                  ) : (
                    <textarea
                      // Remount when observedSeedKey bumps (sidebar click,
                      // rule-driven reseed). Mid-edit the textarea owns its
                      // value and the native undo stack.
                      key={observedSeedKey}
                      ref={observedTextareaRef}
                      className="prompts-textarea"
                      defaultValue={observedEditText}
                      onInput={(e) => setObservedEditText(e.currentTarget.value)}
                      spellCheck={false}
                    />
                  )}
                </div>

                <div className="prompts-editor-footer">
                  <span className="prompts-char-count">
                    {observedEditText.length.toLocaleString()} characters
                  </span>
                  {observedEdited && <span className="prompts-unsaved">edited</span>}
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
                    <RuleMatchCount count={ruleMatchCounts[rule.id] ?? 0} />
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
