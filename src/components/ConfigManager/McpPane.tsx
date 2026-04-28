import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../Dropdown/Dropdown";
import type { PaneComponentProps } from "./ThreePaneEditor";
import { useUnsavedTextEditor } from "./UnsavedTextEditors";
import "./McpPane.css";

// ── Types ────────────────────────────────────────────────────────────────

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "sse" | "http";
  transport?: "sse" | "http" | "streamable_http";
  url?: string;
  headers?: Record<string, string>;
  http_headers?: Record<string, string>;
  bearer_token_env_var?: string;
  [key: string]: unknown;
}

type Transport = "stdio" | "sse" | "http";
type CopyMode = "missing" | "overwrite";

interface FlatServer {
  name: string;
  server: McpServerEntry;
}

interface FormState {
  name: string;
  transport: Transport;
  command: string;
  args: string;
  url: string;
  envText: string;
  headerText: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  envText: "",
  headerText: "",
};

const MCP_TRANSPORT_OPTIONS = [
  { value: "stdio", label: "stdio" },
  { value: "sse", label: "sse" },
  { value: "http", label: "http" },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function detectTransport(s: McpServerEntry): Transport {
  if (s.type === "sse") return "sse";
  if (s.type === "http") return "http";
  if (s.transport === "sse") return "sse";
  if (s.transport === "http" || s.transport === "streamable_http") return "http";
  if (s.url) return "http";
  return "stdio";
}

function parseKvPairs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return result;
}

function kvToText(record: Record<string, string> | undefined): string {
  if (!record) return "";
  return Object.entries(record).map(([k, v]) => `${k}=${v}`).join("\n");
}

function parseArgs(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function buildEntry(form: FormState, cli: PaneComponentProps["cli"]): McpServerEntry {
  if (form.transport === "stdio") {
    const entry: McpServerEntry = { command: form.command.trim() };
    const args = parseArgs(form.args);
    if (args.length > 0) entry.args = args;
    const env = parseKvPairs(form.envText);
    if (Object.keys(env).length > 0) entry.env = env;
    return entry;
  }
  // sse or http
  const entry: McpServerEntry = { url: form.url.trim() };
  if (cli === "claude") entry.type = form.transport as "sse" | "http";
  else if (form.transport === "sse") entry.transport = "sse";
  const headers = parseKvPairs(form.headerText);
  if (Object.keys(headers).length > 0) {
    if (cli === "codex") entry.http_headers = headers;
    else entry.headers = headers;
  }
  return entry;
}

function normalizeForCli(server: McpServerEntry, cli: PaneComponentProps["cli"]): McpServerEntry {
  const transport = detectTransport(server);
  if (transport === "stdio") {
    const entry: McpServerEntry = { ...server };
    delete entry.type;
    delete entry.transport;
    delete entry.url;
    delete entry.headers;
    delete entry.http_headers;
    return entry;
  }

  const headers = server.headers ?? server.http_headers;
  const entry: McpServerEntry = { ...server, url: server.url };
  delete entry.command;
  delete entry.args;
  delete entry.env;

  if (cli === "codex") {
    delete entry.type;
    delete entry.headers;
    if (transport === "sse") entry.transport = "sse";
    else delete entry.transport;
    if (headers && Object.keys(headers).length > 0) entry.http_headers = headers;
    else delete entry.http_headers;
  } else {
    delete entry.transport;
    delete entry.http_headers;
    entry.type = transport === "sse" ? "sse" : "http";
    if (headers && Object.keys(headers).length > 0) entry.headers = headers;
    else delete entry.headers;
  }

  return entry;
}

function serverToForm(name: string, server: McpServerEntry): FormState {
  const transport = detectTransport(server);
  return {
    name,
    transport,
    command: server.command || "",
    args: server.args?.join("\n") || "",
    url: server.url || "",
    envText: kvToText(server.env),
    headerText: kvToText(server.headers ?? server.http_headers),
  };
}

function formChanged(a: FormState, b: FormState): boolean {
  return a.name !== b.name ||
    a.transport !== b.transport ||
    a.command !== b.command ||
    a.args !== b.args ||
    a.url !== b.url ||
    a.envText !== b.envText ||
    a.headerText !== b.headerText;
}

function formToDiffText(form: FormState): string {
  const lines = [
    `name=${form.name}`,
    `transport=${form.transport}`,
  ];
  if (form.transport === "stdio") {
    lines.push(`command=${form.command}`);
    if (form.args) lines.push(`args:\n${form.args}`);
    if (form.envText) lines.push(`env:\n${form.envText}`);
  } else {
    lines.push(`url=${form.url}`);
    if (form.headerText) lines.push(`headers:\n${form.headerText}`);
  }
  return lines.join("\n");
}

function isFormValid(form: FormState, servers: Record<string, McpServerEntry>, editing: FlatServer | null): boolean {
  if (!form.name.trim()) return false;
  // Name uniqueness: check against existing servers, excluding the one being edited
  const nameExists = form.name.trim() in servers && form.name.trim() !== editing?.name;
  if (nameExists) return false;
  if (form.transport === "stdio" && !form.command.trim()) return false;
  if (form.transport !== "stdio" && !form.url.trim()) return false;
  return true;
}

// ── Component ────────────────────────────────────────────────────────────

export function McpPane({ scope, projectDir, cli, onStatus }: PaneComponentProps) {
  const [servers, setServers] = useState<Record<string, McpServerEntry>>({});
  const [editing, setEditing] = useState<FlatServer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [formSeedKey, setFormSeedKey] = useState(0);
  const [copyMode, setCopyMode] = useState<CopyMode>("missing");

  const workingDir = scope === "user" ? "" : projectDir;
  const peerCli = cli === "codex" ? "claude" : "codex";
  const peerName = peerCli === "codex" ? "Codex" : "Claude";

  const loadServers = useCallback(async () => {
    try {
      const raw = await invoke<string>(cli === "codex" ? "read_codex_mcp_servers" : "read_mcp_servers", { scope, workingDir });
      const parsed = raw ? JSON.parse(raw) : {};
      setServers((parsed as Record<string, McpServerEntry>) || {});
    } catch {
      setServers({});
    }
  }, [scope, workingDir, cli]);

  useEffect(() => { loadServers(); }, [loadServers]);

  const saveServers = useCallback(async (updated: Record<string, McpServerEntry>) => {
    try {
      await invoke(cli === "codex" ? "write_codex_mcp_servers" : "write_mcp_servers", {
        scope, workingDir,
        serversJson: JSON.stringify(updated),
      });
      onStatus({ text: "MCP servers saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
      await loadServers();
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [scope, workingDir, cli, loadServers, onStatus]);

  const handleSave = useCallback(async () => {
    if (!isFormValid(form, servers, editing)) return;

    const updated: Record<string, McpServerEntry> = { ...servers };
    const newEntry: McpServerEntry = editing
      ? { ...editing.server, ...buildEntry(form, cli) }
      : buildEntry(form, cli);

    // When transport changes, clean stale fields from the spread
    if (form.transport === "stdio") {
      delete newEntry.type;
      delete newEntry.transport;
      delete newEntry.url;
      delete newEntry.headers;
      delete newEntry.http_headers;
    } else {
      delete newEntry.command;
      delete newEntry.args;
      delete newEntry.env;
      if (cli === "codex") delete newEntry.type;
      else delete newEntry.transport;
    }

    // Handle rename: delete old key
    if (editing && form.name.trim() !== editing.name) {
      delete updated[editing.name];
    }

    updated[form.name.trim()] = newEntry;
    await saveServers(updated);
    setShowForm(false);
    setEditing(null);
    setForm({ ...EMPTY_FORM });
  }, [form, editing, servers, saveServers, cli]);

  const handleDelete = useCallback((flat: FlatServer) => {
    const updated = { ...servers };
    delete updated[flat.name];
    saveServers(updated);
  }, [servers, saveServers]);

  const handleEdit = useCallback((flat: FlatServer) => {
    setEditing(flat);
    setForm(serverToForm(flat.name, flat.server));
    setShowForm(true);
    setFormSeedKey((k) => k + 1);
  }, []);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditing(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  const handleAdd = useCallback(() => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setShowForm(true);
    setFormSeedKey((k) => k + 1);
  }, []);

  const handleCopyFromPeer = useCallback(async () => {
    try {
      const raw = await invoke<string>(peerCli === "codex" ? "read_codex_mcp_servers" : "read_mcp_servers", {
        scope,
        workingDir,
      });
      const source = (raw ? JSON.parse(raw) : {}) as Record<string, McpServerEntry>;
      const sourceEntries = Object.entries(source);
      if (sourceEntries.length === 0) {
        onStatus({ text: `No ${peerName} MCP servers found`, type: "error" });
        return;
      }
      const updated: Record<string, McpServerEntry> = { ...servers };
      let copied = 0;
      let skipped = 0;
      for (const [name, server] of sourceEntries) {
        if (copyMode === "missing" && Object.prototype.hasOwnProperty.call(updated, name)) {
          skipped += 1;
          continue;
        }
        updated[name] = normalizeForCli(server, cli);
        copied += 1;
      }
      await saveServers(updated);
      setServers(updated);
      onStatus({
        text: `Copied ${copied} MCP server${copied === 1 ? "" : "s"} from ${peerName}${skipped ? ` (${skipped} skipped)` : ""}`,
        type: "success",
      });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Copy failed: ${err}`, type: "error" });
    }
  }, [peerCli, peerName, scope, workingDir, servers, copyMode, cli, saveServers, onStatus]);

  const flatServers: FlatServer[] = Object.entries(servers).map(([name, server]) => ({ name, server }));

  useUnsavedTextEditor(`${cli}:mcp:${scope}:${projectDir}:${editing?.name ?? "new"}`, () => {
    if (!showForm) return null;
    const beforeForm = editing ? serverToForm(editing.name, editing.server) : { ...EMPTY_FORM };
    if (!formChanged(form, beforeForm)) return null;
    const scopeLabel = scope === "project" ? "Project" : "User";
    return {
      title: editing ? `MCP server ${editing.name} (${scopeLabel})` : `New MCP server (${scopeLabel})`,
      before: formToDiffText(beforeForm),
      after: formToDiffText(form),
    };
  });

  return (
    <div className="mcp-pane">
      <div className="mcp-pane-list">
        {flatServers.length === 0 ? (
          <div className="pane-hint">No MCP servers</div>
        ) : (
          flatServers.map((flat) => {
            const transport = detectTransport(flat.server);
            const envCount = flat.server.env ? Object.keys(flat.server.env).length : 0;
            const headerCount = flat.server.headers
              ? Object.keys(flat.server.headers).length
              : flat.server.http_headers ? Object.keys(flat.server.http_headers).length : 0;
            return (
              <div key={flat.name} className="hook-card">
                <div className="hook-card-header">
                  <span className="mcp-server-name">{flat.name}</span>
                  <div className="hook-card-actions">
                    <span className="hook-type-badge">{transport}</span>
                    <button className="hook-card-btn" onClick={() => handleEdit(flat)}>Edit</button>
                    <button className="hook-card-btn hook-card-btn-delete" onClick={() => handleDelete(flat)}>Del</button>
                  </div>
                </div>
                {transport === "stdio" && (
                  <div className="hook-detail">
                    <span className="hook-detail-label">Cmd:</span>
                    <span className="hook-detail-value">
                      {flat.server.command}{flat.server.args?.length ? " " + flat.server.args.join(" ") : ""}
                    </span>
                  </div>
                )}
                {transport !== "stdio" && flat.server.url && (
                  <div className="hook-detail">
                    <span className="hook-detail-label">URL:</span>
                    <span className="hook-detail-value">{flat.server.url}</span>
                  </div>
                )}
                {envCount > 0 && (
                  <div className="hook-detail">
                    <span className="hook-detail-label">Env:</span>
                    <span className="hook-detail-value">{envCount} var{envCount !== 1 ? "s" : ""}</span>
                  </div>
                )}
                {headerCount > 0 && (
                  <div className="hook-detail">
                    <span className="hook-detail-label">Headers:</span>
                    <span className="hook-detail-value">{headerCount} header{headerCount !== 1 ? "s" : ""}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {!showForm && (
        <div className="mcp-pane-actions">
          <button className="mcp-pane-add" onClick={handleAdd}>
            + Add Server
          </button>
          <button className="mcp-pane-copy" onClick={handleCopyFromPeer}>
            Copy from {peerName}
          </button>
          <Dropdown
            className="mcp-pane-copy-mode"
            value={copyMode}
            onChange={(v) => setCopyMode(v as CopyMode)}
            ariaLabel="MCP copy mode"
            options={[
              { value: "missing", label: "Missing only" },
              { value: "overwrite", label: "Overwrite" },
            ]}
          />
        </div>
      )}

      {showForm && (
        <div className="mcp-form">
          <div className="mcp-form-title">{editing ? "Edit Server" : "Add Server"}</div>

          <div className="mcp-form-row">
            <span className="mcp-form-label">Name</span>
            <input
              // Uncontrolled: defaultValue + onInput keeps state in sync, while
              // a fresh formSeedKey on Add/Edit/transport-change forces remount
              // so defaultValue actually reseeds.
              key={`name-${formSeedKey}`}
              className="mcp-form-input"
              defaultValue={form.name}
              onInput={(e) => setForm((f) => ({ ...f, name: e.currentTarget.value }))}
              placeholder="server-name"
            />
            {form.name.trim() && form.name.trim() in servers && form.name.trim() !== editing?.name && (
              <span className="mcp-form-hint mcp-form-error">exists</span>
            )}
          </div>

          <div className="mcp-form-row">
            <span className="mcp-form-label">Transport</span>
            <Dropdown
              className="mcp-form-select"
              value={form.transport}
              onChange={(v) => setForm((f) => ({ ...f, transport: v as Transport }))}
              ariaLabel="MCP transport"
              options={MCP_TRANSPORT_OPTIONS}
            />
          </div>

          {form.transport === "stdio" && (
            <>
              <div className="mcp-form-row">
                <span className="mcp-form-label">Command</span>
                <input
                  key={`command-${formSeedKey}`}
                  className="mcp-form-input"
                  defaultValue={form.command}
                  onInput={(e) => setForm((f) => ({ ...f, command: e.currentTarget.value }))}
                  placeholder="python"
                />
              </div>

              <div className="mcp-form-row mcp-form-row-top">
                <span className="mcp-form-label">Args</span>
                <textarea
                  key={`args-${formSeedKey}`}
                  className="mcp-form-textarea"
                  defaultValue={form.args}
                  onInput={(e) => setForm((f) => ({ ...f, args: e.currentTarget.value }))}
                  placeholder={"one arg per line\nserver.py\n--port\n8080"}
                  rows={3}
                />
              </div>

              <div className="mcp-form-row mcp-form-row-top">
                <span className="mcp-form-label">Env</span>
                <textarea
                  key={`env-${formSeedKey}`}
                  className="mcp-form-textarea"
                  defaultValue={form.envText}
                  onInput={(e) => setForm((f) => ({ ...f, envText: e.currentTarget.value }))}
                  placeholder={"KEY=VALUE per line\nAPI_KEY=abc123"}
                  rows={2}
                />
              </div>
            </>
          )}

          {form.transport !== "stdio" && (
            <>
              <div className="mcp-form-row">
                <span className="mcp-form-label">URL</span>
                <input
                  key={`url-${formSeedKey}`}
                  className="mcp-form-input"
                  defaultValue={form.url}
                  onInput={(e) => setForm((f) => ({ ...f, url: e.currentTarget.value }))}
                  placeholder={cli === "codex" ? "https://mcp.example.com/mcp" : "https://mcp.example.com/sse"}
                />
              </div>

              <div className="mcp-form-row mcp-form-row-top">
                <span className="mcp-form-label">Headers</span>
                <textarea
                  key={`headers-${formSeedKey}`}
                  className="mcp-form-textarea"
                  defaultValue={form.headerText}
                  onInput={(e) => setForm((f) => ({ ...f, headerText: e.currentTarget.value }))}
                  placeholder={"KEY=VALUE per line\nAuthorization=Bearer ${TOKEN}"}
                  rows={2}
                />
              </div>
            </>
          )}

          <div className="mcp-form-actions">
            <button className="mcp-form-cancel" onClick={handleCancel}>Cancel</button>
            <button
              className="mcp-form-save"
              onClick={handleSave}
              disabled={!isFormValid(form, servers, editing)}
            >
              {editing ? "Update" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
