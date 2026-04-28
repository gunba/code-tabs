import type { SubagentTab } from "../../lib/contextProjection";
import type { SubagentMessage } from "../../types/session";
import { SubagentMessageEntry } from "./blocks";

export function SubagentTabContent({ tab, messages, expandedSet, onToggle }: {
  tab: SubagentTab;
  messages?: SubagentMessage[];
  expandedSet: Set<string>;
  onToggle: (key: string) => void;
}) {
  const promptKey = `${tab.id}:prompt`;
  const resultKey = `${tab.id}:result`;

  return (
    <div className="context-unified-list">
      <div className="context-entry">
        <button className="context-entry-header" onClick={() => onToggle(promptKey)}>
          <span className="context-entry-role context-role-system">prompt</span>
          <span className="context-entry-meta">{tab.promptText.length.toLocaleString()} chars</span>
          {!expandedSet.has(promptKey) && (
            <span className="context-entry-preview">{tab.promptText.slice(0, 120)}{tab.promptText.length > 120 ? "..." : ""}</span>
          )}
          <span className="context-entry-chevron">{expandedSet.has(promptKey) ? "\u25BC" : "\u25B6"}</span>
        </button>
        {expandedSet.has(promptKey) && (
          <div className="context-entry-body">
            <pre className="context-block-text">{tab.promptText}</pre>
          </div>
        )}
      </div>

      {messages && messages.length > 0 && (
        <>
          <div className="context-subagent-conversation-header">
            <span className="context-entry-meta">{messages.length} sidechain messages</span>
          </div>
          {messages.map((msg, i) => {
            const msgKey = `${tab.id}:msg-${i}`;
            return (
              <SubagentMessageEntry
                key={msgKey}
                msg={msg}
                expanded={expandedSet.has(msgKey)}
                onToggle={() => onToggle(msgKey)}
              />
            );
          })}
        </>
      )}

      {tab.resultText != null ? (
        <div className="context-entry">
          <button className="context-entry-header" onClick={() => onToggle(resultKey)}>
            <span className="context-entry-role context-role-assistant">result</span>
            <span className="context-entry-meta">{tab.resultText.length.toLocaleString()} chars</span>
            {!expandedSet.has(resultKey) && (
              <span className="context-entry-preview">{tab.resultText.slice(0, 120)}{tab.resultText.length > 120 ? "..." : ""}</span>
            )}
            <span className="context-entry-chevron">{expandedSet.has(resultKey) ? "\u25BC" : "\u25B6"}</span>
          </button>
          {expandedSet.has(resultKey) && (
            <div className="context-entry-body">
              <pre className="context-block-text">{tab.resultText}</pre>
            </div>
          )}
        </div>
      ) : (
        <div className="context-subagent-pending">Pending...</div>
      )}
    </div>
  );
}
