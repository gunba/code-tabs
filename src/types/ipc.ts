import type { ContentSearchMatch, Session, SessionConfig, SessionState } from "./session";

// Tauri IPC command signatures — mirrors src-tauri/src/commands.rs
export interface IpcCommands {
  create_session: (args: {
    name: string;
    config: SessionConfig;
  }) => Promise<Session>;
  close_session: (args: { id: string }) => Promise<void>;
  get_session: (args: { id: string }) => Promise<Session>;
  list_sessions: () => Promise<Session[]>;
  set_active_tab: (args: { id: string }) => Promise<void>;
  get_active_tab: () => Promise<string | null>;
  reorder_tabs: (args: { order: string[] }) => Promise<void>;
  update_session_state: (args: {
    id: string;
    state: SessionState;
  }) => Promise<void>;
  set_session_pty_id: (args: {
    id: string;
    ptyId: number;
  }) => Promise<void>;
  persist_sessions: () => Promise<void>;
  load_persisted_sessions: () => Promise<Session[]>;
  detect_claude_cli: () => Promise<string>;
  kill_orphan_sessions: (args: {
    sessionIds: string[];
  }) => Promise<number>;
  build_claude_args: (args: {
    config: SessionConfig;
  }) => Promise<string[]>;
  shell_open: (args: { path: string }) => Promise<void>;
  search_session_content: (args: { query: string }) => Promise<ContentSearchMatch[]>;
  plugin_list: () => Promise<string>;
  plugin_install: (args: { name: string; scope: string }) => Promise<string>;
  plugin_uninstall: (args: { name: string }) => Promise<string>;
  plugin_enable: (args: { name: string }) => Promise<string>;
  plugin_disable: (args: { name: string }) => Promise<string>;
  check_port_available: (args: { port: number }) => Promise<boolean>;
}
