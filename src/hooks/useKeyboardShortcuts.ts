import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { CONFIG_MANAGER_CLOSE_REQUEST_EVENT } from "../components/ConfigManager/events";
import { useSettingsStore } from "../store/settings";
import type { Session, SessionConfig } from "../types/session";
import { writeToPty } from "../lib/ptyRegistry";
import { focusTerminal, releaseTerminalSynchronizedOutput } from "../lib/terminalRegistry";
import { cycleTabId, jumpTabId } from "../lib/tabCycle";
import type { ChangelogRequest } from "../lib/changelog";
import type { TabContextMenuRequest } from "../components/TabContextMenu/TabContextMenu";

type ShortcutSnapshot = {
  activeTabId: string | null;
  sessions: Session[];
  showPalette: boolean;
  showLauncher: boolean;
  showResumePicker: boolean;
  showConfigManager: unknown;
  changelogRequest: ChangelogRequest | null;
  showContextViewer: boolean;
  inspectedSubagent: { sessionId: string; subagentId: string } | null;
  tabContextMenu: TabContextMenuRequest | null;
  devtoolsEnabled: boolean;
};

type ShortcutActions = {
  quickLaunch: () => void;
  closeActiveTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setLastConfig: (config: SessionConfig) => void;
  setShowPalette: Dispatch<SetStateAction<boolean>>;
  setShowLauncher: (show: boolean) => void;
  setShowResumePicker: Dispatch<SetStateAction<boolean>>;
  setShowConfigManager: (tab: string | false) => void;
  setChangelogRequest: Dispatch<SetStateAction<ChangelogRequest | null>>;
  setShowContextViewer: Dispatch<SetStateAction<boolean>>;
  setInspectedSubagent: Dispatch<SetStateAction<{ sessionId: string; subagentId: string } | null>>;
  setTabContextMenu: Dispatch<SetStateAction<TabContextMenuRequest | null>>;
  openMainDevtools: () => Promise<void>;
};

export function useKeyboardShortcuts(snapshot: ShortcutSnapshot, actions: ShortcutActions): void {
  const ref = useRef({ snapshot, actions });
  ref.current = { snapshot, actions };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const {
        snapshot: {
          activeTabId,
          sessions,
          showPalette,
          showLauncher,
          showResumePicker,
          showConfigManager,
          changelogRequest,
          showContextViewer,
          inspectedSubagent,
          tabContextMenu,
          devtoolsEnabled,
        },
        actions: {
          quickLaunch,
          closeActiveTab,
          setActiveTab,
          setLastConfig,
          setShowPalette,
          setShowLauncher,
          setShowResumePicker,
          setShowConfigManager,
          setChangelogRequest,
          setShowContextViewer,
          setInspectedSubagent,
          setTabContextMenu,
          openMainDevtools,
        },
      } = ref.current;

      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        if (e.shiftKey) {
          // [SL-02] Ctrl+Shift+T: quick launch without modal.
          quickLaunch();
        } else {
          // [KB-01] [SL-01] Ctrl+T: open new session (clears resume/fork/continue).
          const lc = useSettingsStore.getState().lastConfig;
          if (lc.resumeSession || lc.forkSession || lc.continueSession) {
            setLastConfig({ ...lc, resumeSession: null, forkSession: false, continueSession: false });
          }
          setShowLauncher(true);
        }
      }

      // [KB-02] Ctrl+W closes the active tab.
      if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeTabId) closeActiveTab(activeTabId);
      }

      // [KB-06] Ctrl+K toggles the command palette.
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }

      // [KB-03] Ctrl+Shift+R opens the resume picker.
      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        setShowResumePicker(true);
      }

      // [KB-11] Ctrl+Shift+F opens the cross-session search panel.
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        useSettingsStore.getState().setRightPanelTab("search");
      }

      // [KB-07] Ctrl+, toggles the Config Manager.
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        if (showConfigManager) {
          window.dispatchEvent(new Event(CONFIG_MANAGER_CLOSE_REQUEST_EVENT));
        } else {
          setShowConfigManager("settings");
        }
      }

      if (devtoolsEnabled && e.ctrlKey && e.shiftKey && e.key === "I") {
        e.preventDefault();
        openMainDevtools().catch(() => {});
      }

      // [KB-09] Escape unwinds transient UI in priority order before sending
      // ESC to the active terminal.
      if (e.key === "Escape") {
        if (tabContextMenu) { setTabContextMenu(null); return; }
        if (showPalette) return;
        if (changelogRequest) { setChangelogRequest(null); return; }
        if (showContextViewer) { setShowContextViewer(false); return; }
        if (showConfigManager) { window.dispatchEvent(new Event(CONFIG_MANAGER_CLOSE_REQUEST_EVENT)); return; }
        if (showResumePicker) { setShowResumePicker(false); return; }
        if (showLauncher) { setShowLauncher(false); return; }
        if (inspectedSubagent) { e.preventDefault(); setInspectedSubagent(null); return; }
        const el = document.activeElement as HTMLElement | null;
        if (el && !el.closest(".xterm")) {
          e.preventDefault();
          el.blur();
          if (activeTabId) {
            requestAnimationFrame(() => focusTerminal(activeTabId));
          }
        } else if (activeTabId) {
          e.preventDefault();
          releaseTerminalSynchronizedOutput(activeTabId);
          writeToPty(activeTabId, "\x1b");
        }
      }

      // [KB-04] Ctrl+Tab and Ctrl+Shift+Tab cycle tabs.
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const nextId = cycleTabId(sessions, activeTabId, e.shiftKey ? "previous" : "next");
        if (nextId) setActiveTab(nextId);
      }

      // [KB-05] Alt+1-9 jumps to the Nth tab.
      if (e.altKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const targetId = jumpTabId(sessions, parseInt(e.key, 10));
        if (targetId) setActiveTab(targetId);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
