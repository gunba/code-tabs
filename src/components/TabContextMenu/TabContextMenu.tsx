import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  disconnectInspectorForSession,
  getInspectorPort,
  reconnectInspectorForSession,
} from "../../lib/inspectorPort";
import { getResumeId } from "../../lib/claude";
import type { TabGroup } from "../../lib/paths";
import type { Session, SessionConfig } from "../../types/session";

export interface TabContextMenuRequest {
  x: number;
  y: number;
  sessionId: string;
}

interface TabContextMenuProps {
  menu: TabContextMenuRequest;
  sessions: Session[];
  groups: TabGroup[];
  regularSessions: Session[];
  observabilityEnabled: boolean;
  inspectorOffSessions: Set<string>;
  onClose: () => void;
  onCloseSession: (sessionId: string) => void;
  onCloseSessionImmediate: (sessionId: string) => void;
  onSetLastConfig: (config: SessionConfig) => void;
  onSetInspectorOff: (sessionId: string, value: boolean) => void;
  onSetShowLauncher: (show: boolean) => void;
}

export function TabContextMenu({
  menu,
  sessions,
  groups,
  regularSessions,
  observabilityEnabled,
  inspectorOffSessions,
  onClose,
  onCloseSession,
  onCloseSessionImmediate,
  onSetLastConfig,
  onSetInspectorOff,
  onSetShowLauncher,
}: TabContextMenuProps) {
  const session = sessions.find((s) => s.id === menu.sessionId);
  if (!session) return null;

  const isDead = session.state === "dead";
  const inspectorPort = !isDead ? getInspectorPort(session.id) : null;
  const inspectorUrl = inspectorPort ? `https://debug.bun.sh/#127.0.0.1:${inspectorPort}/0` : null;
  const group = groups.find((g) => g.sessions.some((s) => s.id === session.id));

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 199 }}
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="tab-context-menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="tab-context-menu-item"
          onClick={() => {
            const sid = session.config.sessionId || session.id;
            navigator.clipboard.writeText(sid);
            onClose();
          }}
        >
          Copy Session ID
        </button>
        <button
          className="tab-context-menu-item"
          onClick={() => {
            navigator.clipboard.writeText(session.config.workingDir);
            onClose();
          }}
        >
          Copy Working Directory
        </button>
        <button
          className="tab-context-menu-item"
          onClick={() => {
            invoke("shell_open", { path: session.config.workingDir });
            onClose();
          }}
        >
          Open in Explorer
        </button>
        {inspectorUrl && (
          <>
            <button
              className="tab-context-menu-item"
              onClick={() => {
                invoke("shell_open", { path: inspectorUrl });
                disconnectInspectorForSession(session.id);
                onSetInspectorOff(session.id, true);
                onClose();
              }}
            >
              Open Inspector
            </button>
            <button
              className="tab-context-menu-item"
              onClick={() => {
                navigator.clipboard.writeText(inspectorUrl);
                onClose();
              }}
            >
              Copy Inspector URL
            </button>
            {inspectorOffSessions.has(session.id) && (
              <button
                className="tab-context-menu-item"
                onClick={() => {
                  reconnectInspectorForSession(session.id);
                  onSetInspectorOff(session.id, false);
                  onClose();
                }}
              >
                Reconnect Inspector
              </button>
            )}
          </>
        )}
        {observabilityEnabled && (
          <>
            <div className="tab-context-menu-label">Observability</div>
            <button
              className="tab-context-menu-item"
              onClick={() => {
                invoke("open_session_data_dir", { sessionId: session.id });
                onClose();
              }}
            >
              Open Session Data
            </button>
            <button
              className="tab-context-menu-item"
              onClick={() => {
                invoke("open_tap_log", { sessionId: session.id });
                onClose();
              }}
            >
              Open Tap Log
            </button>
            <button
              className="tab-context-menu-item"
              onClick={() => {
                invoke("open_observability_log", { sessionId: session.id });
                onClose();
              }}
            >
              Open Observability Log
            </button>
          </>
        )}
        {isDead && (
          <button
            className="tab-context-menu-item"
            onClick={() => {
              onSetLastConfig({
                ...session.config,
                resumeSession: getResumeId(session),
              });
              onClose();
              onSetShowLauncher(true);
            }}
          >
            Revive with Options
          </button>
        )}
        {!isDead && (
          <button
            className="tab-context-menu-item"
            onClick={() => {
              onCloseSession(session.id);
              onClose();
            }}
          >
            Close
          </button>
        )}
        {regularSessions.length > 1 && (
          <button
            className="tab-context-menu-item"
            onClick={() => {
              for (const regularSession of regularSessions) {
                if (regularSession.id !== session.id) onCloseSessionImmediate(regularSession.id);
              }
              onClose();
            }}
          >
            Close Other Tabs
          </button>
        )}
        <div className="tab-context-menu-divider" />
        <button
          className="tab-context-menu-item tab-context-menu-item-danger"
          onClick={() => {
            if (group) {
              for (const groupSession of group.sessions) onCloseSessionImmediate(groupSession.id);
            }
            onClose();
          }}
        >
          Close Group ({group ? group.sessions.length : 0})
        </button>
        <button
          className="tab-context-menu-item tab-context-menu-item-danger"
          onClick={() => {
            for (const regularSession of regularSessions) onCloseSessionImmediate(regularSession.id);
            onClose();
          }}
        >
          Close All Tabs ({regularSessions.length})
        </button>
      </div>
    </div>,
    document.body,
  );
}
