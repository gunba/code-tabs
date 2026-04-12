import { Fragment, useEffect } from "react";
import { useSettingsStore } from "../../store/settings";
import { useRuntimeStore } from "../../store/runtime";
import { useActivityStore } from "../../store/activity";
import { useSessionStore } from "../../store/sessions";
import { ActivityPanel } from "../ActivityPanel/ActivityPanel";
import { SearchPanel } from "../SearchPanel/SearchPanel";
import { DebugPanel } from "../DebugPanel/DebugPanel";
import { IconFolder, IconSearch, IconTerminal } from "../Icons/Icons";
import type { ViewMode } from "../../types/activity";
import "./RightPanel.css";

type RightPanelTab = "activity" | "search" | "debug";

const BASE_TABS = [
  { id: "activity" as const, label: "Activity", icon: <IconFolder size={13} /> },
  { id: "search" as const, label: "Search", icon: <IconSearch size={13} /> },
  { id: "debug" as const, label: "Debug Log", icon: <IconTerminal size={13} /> },
];

export function RightPanel() {
  const debugBuild = useRuntimeStore((s) => s.observabilityInfo.debugBuild);
  const rightPanelTab = useSettingsStore((s) => s.rightPanelTab);
  const setRightPanelTab = useSettingsStore((s) => s.setRightPanelTab);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activity = useActivityStore((s) => (activeTabId ? s.sessions[activeTabId] ?? null : null));
  const mode: ViewMode = activity?.viewMode ?? "response";

  useEffect(() => {
    if (!debugBuild && rightPanelTab === "debug") {
      setRightPanelTab("activity");
    }
  }, [debugBuild, rightPanelTab, setRightPanelTab]);

  const activeTab: RightPanelTab = !debugBuild && rightPanelTab === "debug"
    ? "activity"
    : rightPanelTab;
  const tabs = debugBuild ? BASE_TABS : BASE_TABS.filter((tab) => tab.id !== "debug");
  // [RI-01] Response/Session pill is inline after Activity tab, visible only when activity tab active + session open
  const showPill = activeTab === "activity" && !!activeTabId;

  const setMode = (m: ViewMode) => {
    if (activeTabId) useActivityStore.getState().setViewMode(activeTabId, m);
  };

  return (
    <aside className="right-panel">
      <div className="right-panel-header">
        <div className="right-panel-tabs" role="tablist" aria-label="Right panel tabs">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const isActivityWithPill = tab.id === "activity" && showPill;
            return (
              <Fragment key={tab.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={
                    `right-panel-tab${isActive ? " right-panel-tab-active" : ""}` +
                    (isActivityWithPill ? " right-panel-tab-no-border" : "")
                  }
                  onClick={() => setRightPanelTab(tab.id)}
                >
                  <span className="right-panel-tab-icon">{tab.icon}</span>
                  <span className="right-panel-tab-label">{tab.label}</span>
                </button>
                {isActivityWithPill && (
                  <div className="right-panel-tab-pill-slot">
                    <div
                      className="right-panel-tab-pill"
                      role="group"
                      aria-label="Activity view mode"
                    >
                      <button
                        type="button"
                        className={`right-panel-pill-btn${mode === "response" ? " active" : ""}`}
                        onClick={() => setMode("response")}
                      >
                        Response
                      </button>
                      <button
                        type="button"
                        className={`right-panel-pill-btn${mode === "session" ? " active" : ""}`}
                        onClick={() => setMode("session")}
                      >
                        Session
                      </button>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="right-panel-content">
        {activeTab === "activity" && <ActivityPanel />}
        {activeTab === "search" && <SearchPanel />}
        {activeTab === "debug" && debugBuild && <DebugPanel />}
      </div>
    </aside>
  );
}
