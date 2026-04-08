import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../store/settings";
import type { StatusMessage } from "../../lib/settingsSchema";
import type { ModelProvider, ModelMapping, ProviderConfig } from "../../types/session";
import { parseSocks5Url, buildSocks5Url } from "../../lib/socks5Url";
import type { Socks5Parts } from "../../lib/socks5Url";
import "./ProvidersPane.css";

interface ProvidersPaneProps {
  visible: boolean;
  onStatus: (msg: StatusMessage) => void;
}

export function ProvidersPane({ visible, onStatus }: ProvidersPaneProps) {
  const providerConfig = useSettingsStore((s) => s.providerConfig);
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig);

  const save = useCallback(async (newConfig: ProviderConfig) => {
    setProviderConfig(newConfig);
    try {
      await invoke("update_provider_config", { config: newConfig });
      onStatus({ type: "success", text: "Provider config updated" });
    } catch (e) {
      onStatus({ type: "error", text: `Failed to update proxy: ${e}` });
    }
  }, [setProviderConfig, onStatus]);

  // ── Provider CRUD ──────────────────────────────────────────────

  const addProvider = useCallback(() => {
    const id = `provider-${Date.now()}`;
    const newProvider: ModelProvider = {
      id,
      name: "New Provider",
      kind: "anthropic_compatible",
      predefined: false,
      modelMappings: [],
      baseUrl: "",
      apiKey: null,
    };
    save({ ...providerConfig, providers: [...providerConfig.providers, newProvider] });
  }, [providerConfig, save]);

  const removeProvider = useCallback((id: string) => {
    const providers = providerConfig.providers.filter((p) => p.id !== id);
    const defaultId = providerConfig.defaultProviderId === id
      ? (providers[0]?.id ?? "anthropic")
      : providerConfig.defaultProviderId;
    save({ providers, defaultProviderId: defaultId });
  }, [providerConfig, save]);

  const updateProvider = useCallback((id: string, updates: Partial<ModelProvider>) => {
    const providers = providerConfig.providers.map((p) =>
      p.id === id ? { ...p, ...updates } : p
    );
    save({ ...providerConfig, providers });
  }, [providerConfig, save]);

  const setDefault = useCallback((id: string) => {
    save({ ...providerConfig, defaultProviderId: id });
  }, [providerConfig, save]);

  // ── Per-provider mapping CRUD ──────────────────────────────────

  const addMapping = useCallback((providerId: string) => {
    const mapping: ModelMapping = {
      id: `mapping-${Date.now()}`,
      pattern: "",
    };
    const providers = providerConfig.providers.map((p) =>
      p.id === providerId
        ? { ...p, modelMappings: [...p.modelMappings, mapping] }
        : p
    );
    save({ ...providerConfig, providers });
  }, [providerConfig, save]);

  const removeMapping = useCallback((providerId: string, mappingId: string) => {
    const providers = providerConfig.providers.map((p) =>
      p.id === providerId
        ? { ...p, modelMappings: p.modelMappings.filter((m) => m.id !== mappingId) }
        : p
    );
    save({ ...providerConfig, providers });
  }, [providerConfig, save]);

  const updateMapping = useCallback((providerId: string, mappingId: string, updates: Partial<ModelMapping>) => {
    const providers = providerConfig.providers.map((p) =>
      p.id === providerId
        ? { ...p, modelMappings: p.modelMappings.map((m) => m.id === mappingId ? { ...m, ...updates } : m) }
        : p
    );
    save({ ...providerConfig, providers });
  }, [providerConfig, save]);

  const moveMapping = useCallback((providerId: string, mappingId: string, direction: -1 | 1) => {
    const providers = providerConfig.providers.map((p) => {
      if (p.id !== providerId) return p;
      const mappings = [...p.modelMappings];
      const idx = mappings.findIndex((m) => m.id === mappingId);
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= mappings.length) return p;
      [mappings[idx], mappings[newIdx]] = [mappings[newIdx], mappings[idx]];
      return { ...p, modelMappings: mappings };
    });
    save({ ...providerConfig, providers });
  }, [providerConfig, save]);

  if (!visible) return null;

  return (
    <div className="providers-pane">
      <div className="providers-section">
        <div className="providers-section-header">
          <span>Providers</span>
          <button className="providers-add-btn" onClick={addProvider}>+ Add</button>
        </div>
        <div className="providers-list">
          {[...providerConfig.providers]
            .sort((a, b) => (b.predefined ? 1 : 0) - (a.predefined ? 1 : 0))
            .map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              isDefault={p.id === providerConfig.defaultProviderId}
              isOnly={providerConfig.providers.length === 1}
              onUpdate={(u) => updateProvider(p.id, u)}
              onRemove={() => removeProvider(p.id)}
              onSetDefault={() => setDefault(p.id)}
              onAddMapping={() => addMapping(p.id)}
              onRemoveMapping={(mid) => removeMapping(p.id, mid)}
              onUpdateMapping={(mid, u) => updateMapping(p.id, mid, u)}
              onMoveMapping={(mid, dir) => moveMapping(p.id, mid, dir)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Provider Card ────────────────────────────────────────────────────────

interface ProviderCardProps {
  provider: ModelProvider;
  isDefault: boolean;
  isOnly: boolean;
  onUpdate: (updates: Partial<ModelProvider>) => void;
  onRemove: () => void;
  onSetDefault: () => void;
  onAddMapping: () => void;
  onRemoveMapping: (id: string) => void;
  onUpdateMapping: (id: string, updates: Partial<ModelMapping>) => void;
  onMoveMapping: (id: string, direction: -1 | 1) => void;
}

// [PR-02] ProvidersPane edits per-provider model mappings and shows
// OAuth-backed controls for the predefined OpenAI Codex provider.
function ProviderCard({
  provider, isDefault, isOnly,
  onUpdate, onRemove, onSetDefault,
  onAddMapping, onRemoveMapping, onUpdateMapping, onMoveMapping,
}: ProviderCardProps) {
  const [showMappings, setShowMappings] = useState(provider.modelMappings.length > 0);
  const isAnthropicCompat = provider.kind === "anthropic_compatible";

  return (
    <div className={`providers-card${isDefault ? " providers-card-default" : ""}`}>
      <div className="providers-card-header">
        <input
          type="text"
          className="providers-card-name"
          value={provider.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="Provider name"
          disabled={provider.predefined}
        />
        <div className="providers-card-actions">
          {!isDefault && (
            <button className="providers-card-btn" onClick={onSetDefault} title="Set as default">
              Default
            </button>
          )}
          {isDefault && <span className="providers-card-badge">Default</span>}
          {!provider.predefined && (
            <button
              className="providers-card-btn providers-card-btn-danger"
              onClick={onRemove}
              title="Remove"
              disabled={isOnly}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Anthropic-compatible fields */}
      {isAnthropicCompat && (
        <div className="providers-card-fields">
          <label className="providers-field">
            <span>Base URL</span>
            <input
              type="text"
              value={provider.baseUrl ?? ""}
              onChange={(e) => onUpdate({ baseUrl: e.target.value })}
              placeholder="https://api.anthropic.com"
            />
          </label>
          <label className="providers-field">
            <span>API Key</span>
            <input
              type="password"
              value={provider.apiKey ?? ""}
              onChange={(e) => onUpdate({ apiKey: e.target.value || null })}
              placeholder={provider.apiKey ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "Passthrough (uses CLI key)"}
            />
          </label>
          <Socks5Fieldset url={provider.socks5Proxy} onCommit={(url) => onUpdate({ socks5Proxy: url })} />
        </div>
      )}

      {/* OpenAI Codex fields */}
      {provider.kind === "openai_codex" && (
        <CodexAuthSection />
      )}

      {/* Model Mappings (collapsible) */}
      {provider.modelMappings.length > 0 && (
        <div className="providers-mappings-section">
          <button
            className="providers-mappings-toggle"
            onClick={() => setShowMappings((s) => !s)}
          >
            {showMappings ? "\u25BC" : "\u25B6"} Mappings ({provider.modelMappings.length})
          </button>
          {showMappings && (
            <>
              <div className="providers-route-header">
                <span></span>
                <span>Pattern</span>
                <span>Rewrite</span>
                <span></span>
              </div>
              <div className="providers-route-list">
                {provider.modelMappings.map((m, i) => (
                  <MappingRow
                    key={m.id}
                    mapping={m}
                    isFirst={i === 0}
                    isLast={i === provider.modelMappings.length - 1}
                    onUpdate={(u) => onUpdateMapping(m.id, u)}
                    onRemove={() => onRemoveMapping(m.id)}
                    onMove={(dir) => onMoveMapping(m.id, dir)}
                  />
                ))}
              </div>
              <button className="providers-add-btn" onClick={onAddMapping} style={{ marginTop: 4, alignSelf: "flex-start" }}>
                + Add
              </button>
            </>
          )}
        </div>
      )}
      {provider.modelMappings.length === 0 && !provider.predefined && (
        <button className="providers-add-btn" onClick={onAddMapping} style={{ alignSelf: "flex-start" }}>
          + Mapping
        </button>
      )}
    </div>
  );
}

// ── Codex Auth Section ──────────────────────────────────────────────────

function CodexAuthSection() {
  const [authStatus, setAuthStatus] = useState<{ loggedIn: boolean; email?: string | null }>({ loggedIn: false });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    invoke<{ logged_in: boolean; email: string | null }>("codex_auth_status")
      .then((s) => setAuthStatus({ loggedIn: s.logged_in, email: s.email }))
      .catch(() => {});

    const unlisten = listen<{ loggedIn: boolean; email?: string }>("codex-auth-changed", (event) => {
      setAuthStatus({ loggedIn: event.payload.loggedIn, email: event.payload.email });
      setLoading(false);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleLogin = () => {
    setLoading(true);
    invoke("codex_login").catch(() => setLoading(false));
  };

  const handleLogout = () => {
    invoke("codex_logout").then(() => setAuthStatus({ loggedIn: false })).catch(() => {});
  };

  return (
    <div className="providers-card-fields">
      <div className="providers-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {authStatus.loggedIn ? (
          <>
            <span style={{ color: "var(--accent)", fontSize: 12 }}>
              Logged in{authStatus.email ? ` as ${authStatus.email}` : ""}
            </span>
            <button className="providers-card-btn" onClick={handleLogout}>Logout</button>
          </>
        ) : (
          <>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Not logged in</span>
            <button className="providers-card-btn" onClick={handleLogin} disabled={loading}>
              {loading ? "Waiting..." : "Login with OpenAI"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── SOCKS5 Fieldset ─────────────────────────────────────────────────────

function Socks5Fieldset({ url, onCommit }: { url: string | null | undefined; onCommit: (url: string | null) => void }) {
  const [fields, setFields] = useState<Socks5Parts>(() => parseSocks5Url(url));

  // Sync from external prop changes (e.g., another tab updates the provider)
  useEffect(() => {
    setFields(parseSocks5Url(url));
  }, [url]);

  const update = (patch: Partial<Socks5Parts>) => setFields((f) => ({ ...f, ...patch }));

  const commit = () => {
    const assembled = buildSocks5Url(fields);
    // Only propagate if the value actually changed
    if (assembled !== (url ?? null)) onCommit(assembled);
  };

  return (
    <div className="socks5-fieldset">
      <div className="socks5-row">
        <span className="socks5-label">SOCKS5</span>
        <select value={fields.protocol} onChange={(e) => { update({ protocol: e.target.value as Socks5Parts["protocol"] }); }} onBlur={commit}>
          <option value="socks5h">socks5h://</option>
          <option value="socks5">socks5://</option>
        </select>
        <input type="text" value={fields.host} onChange={(e) => update({ host: e.target.value })} onBlur={commit} placeholder="host" />
        <span className="socks5-colon">:</span>
        <input type="text" className="socks5-port" value={fields.port} onChange={(e) => update({ port: e.target.value })} onBlur={commit} placeholder="port" inputMode="numeric" />
      </div>
      <div className="socks5-row">
        <span className="socks5-label" />
        <input type="text" value={fields.username} onChange={(e) => update({ username: e.target.value })} onBlur={commit} placeholder="username" />
        <input type="password" value={fields.password} onChange={(e) => update({ password: e.target.value })} onBlur={commit} placeholder="password" />
      </div>
    </div>
  );
}

// ── Mapping Row ─────────────────────────────────────────────────────────

interface MappingRowProps {
  mapping: ModelMapping;
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (updates: Partial<ModelMapping>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}

function MappingRow({ mapping, isFirst, isLast, onUpdate, onRemove, onMove }: MappingRowProps) {
  return (
    <div className="providers-route-row">
      <div className="providers-route-arrows">
        <button disabled={isFirst} onClick={() => onMove(-1)} title="Move up">{"\u25B2"}</button>
        <button disabled={isLast} onClick={() => onMove(1)} title="Move down">{"\u25BC"}</button>
      </div>
      <input
        type="text"
        value={mapping.pattern}
        onChange={(e) => onUpdate({ pattern: e.target.value })}
        placeholder="claude-haiku-*"
      />
      <input
        type="text"
        value={mapping.rewriteModel ?? ""}
        onChange={(e) => onUpdate({ rewriteModel: e.target.value || undefined })}
        placeholder="(keep original)"
      />
      <button className="providers-route-remove" onClick={onRemove} title="Remove mapping">
        {"\u00D7"}
      </button>
    </div>
  );
}
