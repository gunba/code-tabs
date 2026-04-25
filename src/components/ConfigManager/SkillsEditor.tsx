import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../store/settings";
import { dlog } from "../../lib/debugLog";
import { insertTextAtCursor } from "../../lib/domEdit";
import type { AgentFile } from "../../lib/settingsSchema";
import type { PaneComponentProps } from "./ThreePaneEditor";

type Kind = "command" | "skill";

function entryKind(entry: AgentFile): Kind {
  return (entry.kind ?? "command") as Kind;
}

/** Stable list-key encoding: "command:<name>" or "skill:<name>". */
function entryKey(kind: Kind, name: string): string {
  return `${kind}:${name}`;
}

function parseKey(key: string): { kind: Kind; name: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  const kind = key.slice(0, idx);
  if (kind !== "command" && kind !== "skill") return null;
  return { kind, name: key.slice(idx + 1) };
}

const NEW_COMMAND = "__new_command__";
const NEW_SKILL = "__new_skill__";

// [CM-30] SkillsEditor lists commands (.claude/commands/) and skills (.claude/skills/) merged via list_skills (kind tag)
export function SkillsEditor({ scope, projectDir, cli, onStatus }: PaneComponentProps) {
  const [entries, setEntries] = useState<AgentFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [seedKey, setSeedKey] = useState(0);
  const [copying, setCopying] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const commandUsage = useSettingsStore((s) => s.commandUsage);

  const workingDir = scope === "user" ? "" : projectDir;
  const peerCli = cli === "codex" ? "claude" : "codex";
  const peerName = peerCli === "codex" ? "Codex" : "Claude";

  const loadEntries = useCallback(async () => {
    try {
      const result = await invoke<AgentFile[]>(cli === "codex" ? "list_codex_skill_files" : "list_skills", { scope, workingDir });
      setEntries(result);
    } catch (err) {
      dlog("config", null, `list_skills failed: ${err}`, "ERR");
      setEntries([]);
    }
    setLoading(false);
  }, [scope, workingDir, cli]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // Auto-select first entry or new-command mode (commands first since they're simpler).
  useEffect(() => {
    if (!loading && selected === null) {
      if (entries.length > 0) {
        const first = entries[0];
        setSelected(entryKey(entryKind(first), first.name));
      } else {
        setSelected(cli === "codex" ? NEW_SKILL : NEW_COMMAND);
      }
    }
  }, [loading, entries, selected, cli]);

  const isNew = selected === NEW_COMMAND || selected === NEW_SKILL;
  const newKind: Kind = cli === "codex" || selected === NEW_SKILL ? "skill" : "command";

  // Load selected file content (with cancellation to prevent stale writes on rapid selection).
  // On every state transition (new entry, load complete, error) we bump seedKey
  // so the textarea remounts and `defaultValue` reseeds while keeping the
  // browser's native undo stack intact mid-edit.
  useEffect(() => {
    if (!selected || isNew) {
      setContent("");
      setSavedContent("");
      setSeedKey((k) => k + 1);
      return;
    }
    const parsed = parseKey(selected);
    if (!parsed) return;
    const exists = entries.some((e) => e.name === parsed.name && entryKind(e) === parsed.kind);
    if (!exists) return;

    let cancelled = false;
    invoke<string>("read_config_file", {
      scope,
      workingDir,
      fileType: cli === "codex" ? `codex-skill:${parsed.name}` : `skill:${parsed.kind}:${parsed.name}`,
    }).then((result) => {
      if (cancelled) return;
      setContent(result);
      setSavedContent(result);
      setSeedKey((k) => k + 1);
    }).catch((err) => {
      dlog("config", null, `read ${parsed.kind} failed: ${err}`, "ERR");
      if (cancelled) return;
      setContent("");
      setSavedContent("");
      setSeedKey((k) => k + 1);
    });
    return () => { cancelled = true; };
  }, [selected, isNew, entries, scope, workingDir, cli]);

  const handleSave = useCallback(async () => {
    if (!selected || isNew) return;
    const parsed = parseKey(selected);
    if (!parsed) return;
    const value = textareaRef.current?.value ?? content;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: cli === "codex" ? `codex-skill:${parsed.name}` : `skill:${parsed.kind}:${parsed.name}`,
        content: value,
      });
      setSavedContent(value);
      onStatus({ text: `${parsed.kind === "skill" ? "Skill" : "Command"} saved`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
      useSettingsStore.getState().triggerCommandRefresh();
    } catch (err) {
      dlog("config", null, `save ${parsed.kind} failed: ${err}`, "ERR");
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [selected, isNew, scope, workingDir, cli, content, onStatus]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim().replace(/\.md$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!name) return;
    if (entries.some((e) => e.name === name && entryKind(e) === newKind)) {
      onStatus({ text: `${newKind === "skill" ? "Skill" : "Command"} "${name}" already exists`, type: "error" });
      return;
    }
    const value = textareaRef.current?.value ?? content;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: cli === "codex" ? `codex-skill:${name}` : `skill:${newKind}:${name}`,
        content: value,
      });
      setNewName("");
      await loadEntries();
      setSelected(entryKey(newKind, name));
      setSavedContent(value);
      onStatus({ text: `${newKind === "skill" ? "Skill" : "Command"} "${name}" created`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
      useSettingsStore.getState().triggerCommandRefresh();
    } catch (err) {
      dlog("config", null, `create ${newKind} failed: ${err}`, "ERR");
      onStatus({ text: `Create failed: ${err}`, type: "error" });
    }
  }, [newName, newKind, scope, workingDir, cli, content, entries, loadEntries, onStatus]);

  const handleDelete = useCallback(async () => {
    if (!selected || isNew) return;
    const parsed = parseKey(selected);
    if (!parsed) return;
    try {
      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: cli === "codex" ? `codex-skill-delete:${parsed.name}` : `skill-delete:${parsed.kind}:${parsed.name}`,
        content: "",
      });
      setSelected(null);
      await loadEntries();
      onStatus({ text: `${parsed.kind === "skill" ? "Skill" : "Command"} "${parsed.name}" deleted`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
      useSettingsStore.getState().triggerCommandRefresh();
    } catch (err) {
      dlog("config", null, `delete failed: ${err}`, "ERR");
      onStatus({ text: `Delete failed: ${err}`, type: "error" });
    }
  }, [selected, isNew, scope, workingDir, cli, loadEntries, onStatus]);

  const handleCopyFromPeer = useCallback(async () => {
    setCopying(true);
    try {
      const report = await invoke<{ copied: string[]; skipped: string[] }>("copy_cli_skills", {
        scope,
        workingDir,
        sourceCli: peerCli,
        destCli: cli,
        overwrite: false,
      });
      await loadEntries();
      const copied = report.copied.length;
      const skipped = report.skipped.length;
      onStatus({
        text: `Copied ${copied} skill${copied === 1 ? "" : "s"} from ${peerName}${skipped ? ` (${skipped} skipped)` : ""}`,
        type: "success",
      });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Copy failed: ${err}`, type: "error" });
    } finally {
      setCopying(false);
    }
  }, [scope, workingDir, peerCli, cli, peerName, loadEntries, onStatus]);

  const dirty = isNew ? newName.trim() !== "" && content !== "" : content !== savedContent;

  // Group entries: commands first, then skills.
  const grouped = useMemo(() => {
    const commands = cli === "codex" ? [] : entries.filter((e) => entryKind(e) === "command");
    const skills = entries.filter((e) => entryKind(e) === "skill");
    return { commands, skills };
  }, [entries, cli]);

  if (loading) return <div className="config-md-hint">Loading...</div>;

  const renderItem = (entry: AgentFile) => {
    const kind = entryKind(entry);
    const key = entryKey(kind, entry.name);
    const usage = commandUsage[`/${entry.name}`] || 0;
    return (
      <button
        key={key}
        className={`config-md-editor-item${selected === key ? " active" : ""}`}
        onClick={() => setSelected(key)}
        title={cli === "codex" ? "Skill (.agents/skills/)" : kind === "skill" ? "Skill (.claude/skills/)" : "Command (.claude/commands/)"}
      >
        <span className={`config-md-editor-kind config-md-editor-kind-${kind}`}>
          {kind === "skill" ? "skill" : "cmd"}
        </span>
        {kind === "command" ? `/${entry.name}` : entry.name}
        {usage > 0 && <span className="config-md-editor-usage">{usage}</span>}
      </button>
    );
  };

  const selectedParsed = selected && !isNew ? parseKey(selected) : null;
  const selectedLabel = selectedParsed
    ? selectedParsed.kind === "skill"
      ? `${selectedParsed.name}/SKILL.md`
      : `${selectedParsed.name}.md`
    : "";

  return (
    <div className="config-md-editor">
      <div className="config-md-editor-list">
        {grouped.commands.map(renderItem)}
        {grouped.skills.map(renderItem)}
        {cli === "claude" && (
          <button
            className={`config-md-editor-item config-md-editor-new${selected === NEW_COMMAND ? " active" : ""}`}
            onClick={() => { setSelected(NEW_COMMAND); setNewName(""); }}
          >
            + new command
          </button>
        )}
        <button
          className={`config-md-editor-item config-md-editor-new${selected === NEW_SKILL ? " active" : ""}`}
          onClick={() => { setSelected(NEW_SKILL); setNewName(""); }}
        >
          + new skill
        </button>
        <button
          className="config-md-editor-item config-md-editor-copy"
          onClick={handleCopyFromPeer}
          disabled={copying}
        >
          Copy from {peerName}
        </button>
      </div>

      <div className="config-md-editor-body">
        <div className="config-md-editor-header">
          {isNew ? (
            <input
              className="config-input config-md-editor-name-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={newKind === "skill" ? "skill-name" : "command-name"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty) handleCreate();
                if (e.key === "Escape") e.stopPropagation();
              }}
              autoFocus
            />
          ) : (
            <span className="config-md-editor-name">{selectedParsed?.kind === "command" ? `/${selectedLabel}` : selectedLabel}</span>
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
          // Remount when seedKey changes (selection/load/error transitions)
          // so `defaultValue` reseeds without React writing into a mounted
          // textarea (which would clear the native undo stack).
          key={seedKey}
          ref={textareaRef}
          className="pane-textarea pane-textarea-md"
          defaultValue={content}
          onInput={(e) => setContent(e.currentTarget.value)}
          placeholder={isNew
            ? newKind === "skill"
              ? "SKILL.md content... (frontmatter --- name: ... description: ... --- then body)"
              : "Command prompt content... (use $ARGUMENTS for user input)"
            : ""}
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
