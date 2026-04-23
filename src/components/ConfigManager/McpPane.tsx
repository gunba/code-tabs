import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../Dropdown/Dropdown";
import type { PaneComponentProps } from "./ThreePaneEditor";
import "./McpPane.css";

// ── Types ────────────────────────────────────────────────────────────────

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "sse" | "http";
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

type Transport = "stdio" | "sse" | "http";

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

// ── Helpers ──────────────────────────────────────────────────────────────

function detectTransport(s: McpServerEntry): Transport {
  if (s.type === "sse") return "sse";
  if (s.type === "http") return "http";
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

function buildEntry(form: FormState): McpServerEntry {
  if (form.transport === "stdio") {
    const entry: McpServerEntry = { command: form.command.trim() };
    const args = parseArgs(form.args);
    if (args.length > 0) entry.args = args;
    const env = parseKvPairs(form.envText);
    if (Object.keys(env).length > 0) entry.env = env;
    return entry;
  }
  // sse or http
  const entry: McpServerEntry = {
    type: form.transport as "sse" | "http",
    url: form.url.trim(),
  };
  const headers = parseKvPairs(form.headerText);
  if (Object.keys(headers).length > 0) entry.headers = headers;
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
    headerText: kvToText(server.headers),
  };
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

export function McpPane({ scope, projectDir, onStatus }: PaneComponentProps) {
  const [servers, setServers] = useState<Record<string, McpServerEntry>>({});
  const [editing, setEditing] = useState<FlatServer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });

  const workingDir = scope === "user" ? "" : projectDir;

  const loadServers = useCallback(async () => {
    try {
      const raw = await invoke<string>("read_mcp_servers", { scope, workingDir });
      const parsed = raw ? JSON.parse(raw) : {};
      setServers((parsed as Record<string, McpServerEntry>) || {});
    } catch {
      setServers({});
    }
  }, [scope, workingDir]);

  useEffect(() => { loadServers(); }, [loadServers]);

  const saveServers = useCallback(async (updated: Record<string, McpServerEntry>) => {
    try {
      await invoke("write_mcp_servers", {
        scope, workingDir,
        serversJson: JSON.stringify(updated),
      });
      onStatus({ text: "MCP servers saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
      await loadServers();
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [scope, workingDir, loadServers, onStatus]);

  const handleSave = useCallback(async () => {
    if (!isFormValid(form, servers, editing)) return;

    const updated: Record<string, McpServerEntry> = { ...servers };
    const newEntry: McpServerEntry = editing
      ? { ...editing.server, ...buildEntry(form) }
      : buildEntry(form);

    // When transport changes, clean stale fields from the spread
    if (form.transport === "stdio") {
      delete newEntry.type;
      delete newEntry.url;
      delete newEntry.headers;
    } else {
      delete newEntry.command;
      delete newEntry.args;
      delete newEntry.env;
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
  }, [form, editing, servers, saveServers]);

  const handleDelete = useCallback((flat: FlatServer) => {
    const updated = { ...servers };
    delete updated[flat.name];
    saveServers(updated);
  }, [servers, saveServers]);

  const handleEdit = useCallback((flat: FlatServer) => {
    setEditing(flat);
    setForm(serverToForm(flat.name, flat.server));
    setShowForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditing(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  const flatServers: FlatServer[] = Object.entries(servers).map(([name, server]) => ({ name, server }));

  return (
    <div className="mcp-pane">
      <div className="mcp-pane-list">
        {flatServers.length === 0 ? (
          <div className="pane-hint">No MCP servers</div>
        ) : (
          flatServers.map((flat) => {
            const transport = detectTransport(flat.server);
            const envCount = flat.server.env ? Object.keys(flat.server.env).length : 0;
            const headerCount = flat.server.headers ? Object.keys(flat.server.headers).length : 0;
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
        <button className="mcp-pane-add" onClick={() => { setEditing(null); setForm({ ...EMPTY_FORM }); setShowForm(true); }}>
          + Add Server
        </button>
      )}

      {showForm && (
        <div className="mcp-form">
          <div className="mcp-form-title">{editing ? "Edit Server" : "Add Server"}</div>

          <div className="mcp-form-row">
            <span className="mcp-form-label">Name</span>
            <input
              className="mcp-form-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
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
              options={[
                { value: "stdio", label: "stdio" },
                { value: "sse", label: "sse" },
                { value: "http", label: "http" },
              ]}
            />
          </div>

          {form.transport === "stdio" && (
            <>
              <div className="mcp-form-row">
                <span className="mcp-form-label">Command</span>
                <input
                  className="mcp-form-input"
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  placeholder="python"
                />
              </div>

              <div className="mcp-form-row mcp-form-row-top">
                <span className="mcp-form-label">Args</span>
                <textarea
                  className="mcp-form-textarea"
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  placeholder={"one arg per line\nserver.py\n--port\n8080"}
                  rows={3}
                />
              </div>

              <div className="mcp-form-row mcp-form-row-top">
                <span className="mcp-form-label">Env</span>
                <textarea
                  className="mcp-form-textarea"
                  value={form.envText}
                  onChange={(e) => setForm((f) => ({ ...f, envText: e.target.value }))}
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
                  className="mcp-form-input"
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://mcp.example.com/sse"
                />
              </div>

              <div className="mcp-form-row mcp-form-row-top">
                <span className="mcp-form-label">Headers</span>
                <textarea
                  className="mcp-form-textarea"
                  value={form.headerText}
                  onChange={(e) => setForm((f) => ({ ...f, headerText: e.target.value }))}
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
