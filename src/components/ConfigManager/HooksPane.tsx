import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/sessions";
import type { PaneComponentProps } from "./ThreePaneEditor";

const HOOK_EVENTS = [
  { name: "PreToolUse", desc: "Before tool execution", hasMatcher: true },
  { name: "PostToolUse", desc: "After tool execution", hasMatcher: true },
  { name: "PostToolUseFailure", desc: "After tool failure", hasMatcher: true },
  { name: "PermissionRequest", desc: "Before permission prompt", hasMatcher: true },
  { name: "Notification", desc: "On notifications", hasMatcher: true },
  { name: "Stop", desc: "When Claude stops", hasMatcher: false },
  { name: "PreCompact", desc: "Before compaction", hasMatcher: true },
  { name: "PostCompact", desc: "After compaction", hasMatcher: true },
  { name: "UserPromptSubmit", desc: "When user submits", hasMatcher: false },
  { name: "SessionStart", desc: "Session starts", hasMatcher: false },
  { name: "SessionEnd", desc: "Session ends", hasMatcher: false },
] as const;

const HOOK_TYPES = ["command", "prompt", "agent"] as const;

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface MatcherGroup {
  matcher: string;
  hooks: HookEntry[];
}

interface FlatHook {
  eventName: string;
  matcherIndex: number;
  hookIndex: number;
  matcher: string;
  hook: HookEntry;
}

interface FormState {
  eventName: string;
  matcher: string;
  type: string;
  command: string;
  timeout: number;
  statusMessage: string;
}

const EMPTY_FORM: FormState = {
  eventName: "PreToolUse",
  matcher: "",
  type: "command",
  command: "",
  timeout: 60,
  statusMessage: "",
};

export function HooksPane({ scope, projectDir, onStatus }: PaneComponentProps) {
  const [hooksData, setHooksData] = useState<Record<string, Record<string, MatcherGroup[]>>>({});
  const [editing, setEditing] = useState<FlatHook | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });

  const loadHooks = useCallback(async () => {
    try {
      const dirs = projectDir ? [projectDir] : [];
      const result = await invoke<Record<string, unknown>>("discover_hooks", { workingDirs: dirs });
      const parsed: Record<string, Record<string, MatcherGroup[]>> = {};
      for (const [key, val] of Object.entries(result)) {
        if (typeof val === "object" && val !== null) {
          parsed[key] = val as Record<string, MatcherGroup[]>;
        }
      }
      setHooksData(parsed);
    } catch {
      setHooksData({});
    }
  }, [projectDir]);

  useEffect(() => { loadHooks(); }, [loadHooks]);

  // Derive scope key
  let scopeKey: string;
  if (scope === "user") scopeKey = "user";
  else if (scope === "project-local") scopeKey = `project-local:${projectDir}`;
  else scopeKey = `project:${projectDir}`;

  const currentHooks: Record<string, MatcherGroup[]> = hooksData[scopeKey] ?? {};

  // Flatten for display
  const flatHooks: FlatHook[] = [];
  for (const [eventName, matcherGroups] of Object.entries(currentHooks)) {
    if (!Array.isArray(matcherGroups)) continue;
    matcherGroups.forEach((mg, mi) => {
      if (!Array.isArray(mg.hooks)) return;
      mg.hooks.forEach((hook, hi) => {
        flatHooks.push({ eventName, matcherIndex: mi, hookIndex: hi, matcher: mg.matcher || "", hook });
      });
    });
  }

  const saveHooks = useCallback(async (updatedHooks: Record<string, MatcherGroup[]>) => {
    try {
      const workingDir = scope === "user" ? "" : projectDir;
      await invoke("save_hooks", { scope, workingDir, hooksJson: JSON.stringify(updatedHooks) });
      onStatus({ text: "Hooks saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
      await loadHooks();
      useSessionStore.getState().bumpHookChange();
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [scope, projectDir, loadHooks, onStatus]);

  const handleSave = useCallback(() => {
    if (!form.command.trim()) return;
    const newHook: HookEntry = {
      ...(editing?.hook ?? {}),
      type: form.type,
      command: form.command.trim(),
    };
    newHook.timeout = form.timeout !== 60 ? form.timeout : undefined;
    newHook.statusMessage = form.statusMessage.trim() || undefined;

    const updated: Record<string, MatcherGroup[]> = JSON.parse(JSON.stringify(currentHooks));

    if (editing) {
      const groups = updated[editing.eventName];
      if (groups && groups[editing.matcherIndex]?.hooks[editing.hookIndex]) {
        if (editing.eventName !== form.eventName || groups[editing.matcherIndex].matcher !== form.matcher) {
          groups[editing.matcherIndex].hooks.splice(editing.hookIndex, 1);
          if (groups[editing.matcherIndex].hooks.length === 0) groups.splice(editing.matcherIndex, 1);
          if (groups.length === 0) delete updated[editing.eventName];
          if (!updated[form.eventName]) updated[form.eventName] = [];
          const eg = updated[form.eventName].find((g) => g.matcher === form.matcher);
          if (eg) eg.hooks.push(newHook);
          else updated[form.eventName].push({ matcher: form.matcher, hooks: [newHook] });
        } else {
          groups[editing.matcherIndex].hooks[editing.hookIndex] = newHook;
        }
      }
    } else {
      if (!updated[form.eventName]) updated[form.eventName] = [];
      const eg = updated[form.eventName].find((g) => g.matcher === form.matcher);
      if (eg) eg.hooks.push(newHook);
      else updated[form.eventName].push({ matcher: form.matcher, hooks: [newHook] });
    }

    saveHooks(updated);
    setShowForm(false);
    setEditing(null);
    setForm({ ...EMPTY_FORM });
  }, [form, editing, currentHooks, saveHooks]);

  const handleDelete = useCallback((flat: FlatHook) => {
    const updated: Record<string, MatcherGroup[]> = JSON.parse(JSON.stringify(currentHooks));
    const groups = updated[flat.eventName];
    if (!groups) return;
    const group = groups[flat.matcherIndex];
    if (!group) return;
    group.hooks.splice(flat.hookIndex, 1);
    if (group.hooks.length === 0) groups.splice(flat.matcherIndex, 1);
    if (groups.length === 0) delete updated[flat.eventName];
    saveHooks(updated);
  }, [currentHooks, saveHooks]);

  const handleEdit = useCallback((flat: FlatHook) => {
    setEditing(flat);
    setForm({
      eventName: flat.eventName,
      matcher: flat.matcher,
      type: flat.hook.type || "command",
      command: flat.hook.command || "",
      timeout: flat.hook.timeout ?? 60,
      statusMessage: flat.hook.statusMessage ?? "",
    });
    setShowForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditing(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  const isCustomEvent = !HOOK_EVENTS.some((e) => e.name === form.eventName);
  const eventHasMatcher = isCustomEvent || (HOOK_EVENTS.find((e) => e.name === form.eventName)?.hasMatcher ?? false);

  return (
    <div className="hooks-pane">
      <div className="hooks-pane-list">
        {flatHooks.length === 0 ? (
          <div className="pane-hint">No hooks</div>
        ) : (
          flatHooks.map((flat, idx) => (
            <div key={`${flat.eventName}-${flat.matcherIndex}-${flat.hookIndex}-${idx}`} className="hook-card">
              <div className="hook-card-header">
                <span className="hook-event-name">{flat.eventName}</span>
                <div className="hook-card-actions">
                  <span className="hook-type-badge">{flat.hook.type || "command"}</span>
                  <button className="hook-card-btn" onClick={() => handleEdit(flat)}>Edit</button>
                  <button className="hook-card-btn hook-card-btn-delete" onClick={() => handleDelete(flat)}>Del</button>
                </div>
              </div>
              {flat.matcher && (
                <div className="hook-detail">
                  <span className="hook-detail-label">Match:</span>
                  <span className="hook-detail-value">{flat.matcher}</span>
                </div>
              )}
              <div className="hook-detail">
                <span className="hook-detail-label">Cmd:</span>
                <span className="hook-detail-value">{flat.hook.command}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {!showForm && (
        <button className="hooks-pane-add" onClick={() => { setEditing(null); setForm({ ...EMPTY_FORM }); setShowForm(true); }}>
          + Add Hook
        </button>
      )}

      {showForm && (
        <div className="hooks-pane-form">
          <div className="hooks-pane-form-title">{editing ? "Edit Hook" : "Add Hook"}</div>

          <div className="hooks-pane-form-row">
            <span className="hooks-pane-form-label">Event</span>
            <select
              className="hooks-pane-form-select"
              value={isCustomEvent ? "__custom__" : form.eventName}
              onChange={(e) => setForm((f) => ({ ...f, eventName: e.target.value === "__custom__" ? "" : e.target.value }))}
            >
              {HOOK_EVENTS.map((ev) => (
                <option key={ev.name} value={ev.name}>{ev.name}</option>
              ))}
              <option value="__custom__">Custom...</option>
            </select>
            {isCustomEvent && (
              <input
                className="hooks-pane-form-input"
                value={form.eventName}
                onChange={(e) => setForm((f) => ({ ...f, eventName: e.target.value }))}
                placeholder="EventName"
              />
            )}
          </div>

          {eventHasMatcher && (
            <div className="hooks-pane-form-row">
              <span className="hooks-pane-form-label">Matcher</span>
              <input
                className="hooks-pane-form-input"
                value={form.matcher}
                onChange={(e) => setForm((f) => ({ ...f, matcher: e.target.value }))}
                placeholder="Bash|Write"
              />
            </div>
          )}

          <div className="hooks-pane-form-row">
            <span className="hooks-pane-form-label">Type</span>
            <select
              className="hooks-pane-form-select"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            >
              {HOOK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="hooks-pane-form-row">
            <span className="hooks-pane-form-label">Command</span>
            <input
              className="hooks-pane-form-input"
              value={form.command}
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              placeholder="npm test"
            />
          </div>

          <div className="hooks-pane-form-row">
            <span className="hooks-pane-form-label">Timeout</span>
            <input
              className="hooks-pane-form-input"
              type="number"
              min={1}
              max={3600}
              value={form.timeout}
              onChange={(e) => setForm((f) => ({ ...f, timeout: parseInt(e.target.value) || 60 }))}
              style={{ maxWidth: 60 }}
            />
            <span className="hooks-pane-form-hint">s</span>
          </div>

          <div className="hooks-pane-form-row">
            <span className="hooks-pane-form-label">Status</span>
            <input
              className="hooks-pane-form-input"
              value={form.statusMessage}
              onChange={(e) => setForm((f) => ({ ...f, statusMessage: e.target.value }))}
              placeholder="Optional"
            />
          </div>

          <div className="hooks-pane-form-actions">
            <button className="hooks-pane-form-cancel" onClick={handleCancel}>Cancel</button>
            <button
              className="hooks-pane-form-save"
              onClick={handleSave}
              disabled={!form.command.trim() || !form.eventName.trim()}
            >
              {editing ? "Update" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
