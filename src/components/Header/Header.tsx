import { useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../../store/settings";
import { useVersionStore } from "../../store/version";
import "./Header.css";

const DRAG_THRESHOLD_PX_SQ = 9; // 3px movement before we start a window drag

// [VA-02] Header (Linux custom titlebar): app version + CLI version display with window controls.
// [PL-03] Header drag mechanism: data-tauri-drag-region removed; startDragging deferred until
// pointer moves past DRAG_THRESHOLD_PX_SQ to preserve click/dblclick on Wayland. Explicit
// dblclick -> toggleMaximize because drag-region dblclick fails on KDE/GNOME Wayland.
// data-tauri-drag-region attribute was removed — startDragging + dblclick are the only drag mechanism.
// Double-click toggles maximize explicitly — the drag-region attribute's dblclick path is
// part of what fails to fire on these compositors.
export function Header() {
  const appVersion = useVersionStore((s) => s.appVersion);
  const cliVersion = useSettingsStore((s) => s.cliVersion);
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".app-header-controls")) return;
    dragOriginRef.current = { x: e.clientX, y: e.clientY };
  };

  const onHeaderMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    if (e.buttons === 0) {
      dragOriginRef.current = null;
      return;
    }
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX_SQ) {
      dragOriginRef.current = null;
      getCurrentWindow().startDragging().catch(() => {});
    }
  };

  const onHeaderMouseUp = () => {
    dragOriginRef.current = null;
  };

  const onHeaderDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest(".app-header-controls")) return;
    getCurrentWindow().toggleMaximize().catch(() => {});
  };

  return (
    <header
      className="app-header"
      onMouseDown={onHeaderMouseDown}
      onMouseMove={onHeaderMouseMove}
      onMouseUp={onHeaderMouseUp}
      onDoubleClick={onHeaderDoubleClick}
    >
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
      <div className="app-header-controls">
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
