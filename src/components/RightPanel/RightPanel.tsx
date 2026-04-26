import { useEffect } from "react";
import { useSettingsStore } from "../../store/settings";
import { useRuntimeStore } from "../../store/runtime";
import { ActivityPanel } from "../ActivityPanel/ActivityPanel";
import { SearchPanel } from "../SearchPanel/SearchPanel";
import { DebugPanel } from "../DebugPanel/DebugPanel";
import { NotesPanel } from "../NotesPanel/NotesPanel";
import { IconNotes, IconResponse, IconSearch, IconSession, IconTerminal } from "../Icons/Icons";
import "./RightPanel.css";

type RightPanelTab = "search" | "response" | "session" | "notes" | "debug";

// [RI-04] BASE_TABS ordered [search, response, session, notes, debug]. Activity tab was removed (8d454f3) — Response/Session render ActivityPanel with a mode prop. Debug tab filtered out unless debugBuild.
const BASE_TABS = [
  { id: "search" as const, label: "Search", icon: <IconSearch size={13} /> },
  { id: "response" as const, label: "Response", icon: <IconResponse size={13} /> },
  { id: "session" as const, label: "Session", icon: <IconSession size={13} /> },
  { id: "notes" as const, label: "Notes", icon: <IconNotes size={13} /> },
  { id: "debug" as const, label: "Debug Log", icon: <IconTerminal size={13} /> },
];

export function RightPanel() {
  const debugBuild = useRuntimeStore((s) => s.observabilityInfo.debugBuild);
  const rightPanelTab = useSettingsStore((s) => s.rightPanelTab);
  const setRightPanelTab = useSettingsStore((s) => s.setRightPanelTab);

  useEffect(() => {
    if (!debugBuild && rightPanelTab === "debug") {
      setRightPanelTab("response");
    }
  }, [debugBuild, rightPanelTab, setRightPanelTab]);

  const activeTab: RightPanelTab = !debugBuild && rightPanelTab === "debug"
    ? "response"
    : rightPanelTab;
  const tabs = BASE_TABS.filter((tab) => tab.id !== "debug" || debugBuild);

  return (
    <aside className="right-panel">
      <div className="right-panel-header">
        <div className="right-panel-tabs" role="tablist" aria-label="Right panel tabs">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`right-panel-tab${isActive ? " right-panel-tab-active" : ""}`}
                onClick={() => setRightPanelTab(tab.id)}
              >
                <span className="right-panel-tab-icon">{tab.icon}</span>
                <span className="right-panel-tab-label">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="right-panel-content">
        {activeTab === "response" && <ActivityPanel mode="response" />}
        {activeTab === "session" && <ActivityPanel mode="session" />}
        {activeTab === "notes" && <NotesPanel />}
        {activeTab === "search" && <SearchPanel />}
        {/* [DP-02] DebugPanel surfaced as a RightPanel tab gated on debugBuild; no global keyboard shortcut. */}
        {activeTab === "debug" && debugBuild && <DebugPanel />}
      </div>
    </aside>
  );
}
