import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../../store/settings";
import { useVersionStore } from "../../store/version";
import "./Header.css";

export function Header() {
  const appVersion = useVersionStore((s) => s.appVersion);
  const cliVersion = useSettingsStore((s) => s.cliVersion);

  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="app-header-title">
        <span className="app-header-name">
          Claude Tabs{appVersion ? ` v${appVersion}` : ""}
        </span>
        {cliVersion && (
          <>
            <span className="app-header-sep">&middot;</span>
            <span className="app-header-cli">CLI {cliVersion}</span>
          </>
        )}
      </div>
      <div className="app-header-controls" data-tauri-drag-region="false">
        <button
          type="button"
          className="app-header-btn"
          onClick={() => getCurrentWindow().minimize().catch(() => {})}
          title="Minimize"
          aria-label="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className="app-header-btn"
          onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}
          title="Maximize"
          aria-label="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className="app-header-btn app-header-btn-close"
          onClick={() => getCurrentWindow().close().catch(() => {})}
          title="Close"
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  );
}
