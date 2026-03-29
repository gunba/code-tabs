import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../store/settings";
import type { StatusMessage } from "../../lib/settingsSchema";
import type { ModelProvider, ModelRoute, ProviderConfig } from "../../types/session";
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
    // Also clean up routes referencing this provider
    const routes = providerConfig.routes.map((r) =>
      r.providerId === id ? { ...r, providerId: defaultId } : r
    );
    save({ providers, routes, defaultProviderId: defaultId });
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

  // ── Route CRUD ─────────────────────────────────────────────────

  const addRoute = useCallback(() => {
    const route: ModelRoute = {
      id: `route-${Date.now()}`,
      pattern: "",
      providerId: providerConfig.defaultProviderId,
    };
    save({ ...providerConfig, routes: [...providerConfig.routes, route] });
  }, [providerConfig, save]);

  const removeRoute = useCallback((id: string) => {
    save({ ...providerConfig, routes: providerConfig.routes.filter((r) => r.id !== id) });
  }, [providerConfig, save]);

  const updateRoute = useCallback((id: string, updates: Partial<ModelRoute>) => {
    const routes = providerConfig.routes.map((r) =>
      r.id === id ? { ...r, ...updates } : r
    );
    save({ ...providerConfig, routes });
  }, [providerConfig, save]);

  const moveRoute = useCallback((id: string, direction: -1 | 1) => {
    const routes = [...providerConfig.routes];
    const idx = routes.findIndex((r) => r.id === id);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= routes.length) return;
    [routes[idx], routes[newIdx]] = [routes[newIdx], routes[idx]];
    save({ ...providerConfig, routes });
  }, [providerConfig, save]);

  if (!visible) return null;

  return (
    <div className="providers-pane">
      {/* ── Providers ────────────────────────────────────────── */}
      <div className="providers-section">
        <div className="providers-section-header">
          <span>Providers</span>
          <button className="providers-add-btn" onClick={addProvider}>+ Add</button>
        </div>
        <div className="providers-list">
          {providerConfig.providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              isDefault={p.id === providerConfig.defaultProviderId}
              isOnly={providerConfig.providers.length === 1}
              onUpdate={(u) => updateProvider(p.id, u)}
              onRemove={() => removeProvider(p.id)}
              onSetDefault={() => setDefault(p.id)}
            />
          ))}
        </div>
      </div>

      {/* ── Model Routes ─────────────────────────────────────── */}
      <div className="providers-section">
        <div className="providers-section-header">
          <span>Model Routes</span>
          <button className="providers-add-btn" onClick={addRoute}>+ Add</button>
        </div>
        <div className="providers-route-header">
          <span></span>
          <span>Pattern</span>
          <span>Rewrite To</span>
          <span>Provider</span>
          <span></span>
        </div>
        <div className="providers-route-list">
          {providerConfig.routes.map((r, i) => (
            <RouteRow
              key={r.id}
              route={r}
              providers={providerConfig.providers}
              isFirst={i === 0}
              isLast={i === providerConfig.routes.length - 1}
              onUpdate={(u) => updateRoute(r.id, u)}
              onRemove={() => removeRoute(r.id)}
              onMove={(dir) => moveRoute(r.id, dir)}
            />
          ))}
        </div>
        <p className="providers-route-hint">
          Routes match top-to-bottom. First match wins. Unmatched requests go to the default provider.
          Patterns use glob syntax (e.g. claude-haiku-*).
        </p>
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
}

function ProviderCard({ provider, isDefault, isOnly, onUpdate, onRemove, onSetDefault }: ProviderCardProps) {
  return (
    <div className={`providers-card${isDefault ? " providers-card-default" : ""}`}>
      <div className="providers-card-header">
        <input
          type="text"
          className="providers-card-name"
          value={provider.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="Provider name"
        />
        <div className="providers-card-actions">
          {!isDefault && (
            <button className="providers-card-btn" onClick={onSetDefault} title="Set as default">
              Default
            </button>
          )}
          {isDefault && <span className="providers-card-badge">Default</span>}
          <button className="providers-card-btn providers-card-btn-danger" onClick={onRemove} title="Remove" disabled={isOnly}>
            Remove
          </button>
        </div>
      </div>
      <div className="providers-card-fields">
        <label className="providers-field">
          <span>Base URL</span>
          <input
            type="text"
            value={provider.baseUrl}
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
        <label className="providers-field">
          <span>SOCKS5</span>
          <input
            type="text"
            value={provider.socks5Proxy ?? ""}
            onChange={(e) => onUpdate({ socks5Proxy: e.target.value || null })}
            placeholder="socks5h://user:pass@host:port"
          />
        </label>
      </div>
    </div>
  );
}

// ── Route Row ────────────────────────────────────────────────────────────

interface RouteRowProps {
  route: ModelRoute;
  providers: ModelProvider[];
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (updates: Partial<ModelRoute>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}

function RouteRow({ route, providers, isFirst, isLast, onUpdate, onRemove, onMove }: RouteRowProps) {
  return (
    <div className="providers-route-row">
      <div className="providers-route-arrows">
        <button disabled={isFirst} onClick={() => onMove(-1)} title="Move up">{"\u25B2"}</button>
        <button disabled={isLast} onClick={() => onMove(1)} title="Move down">{"\u25BC"}</button>
      </div>
      <input
        type="text"
        value={route.pattern}
        onChange={(e) => onUpdate({ pattern: e.target.value })}
        placeholder="claude-haiku-*"
      />
      <input
        type="text"
        value={route.rewriteModel ?? ""}
        onChange={(e) => onUpdate({ rewriteModel: e.target.value || undefined })}
        placeholder="(keep original)"
      />
      <select
        value={route.providerId}
        onChange={(e) => onUpdate({ providerId: e.target.value })}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button className="providers-route-remove" onClick={onRemove} title="Remove route">
        {"\u00D7"}
      </button>
    </div>
  );
}
