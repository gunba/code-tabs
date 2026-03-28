import { memo } from "react";
import { useSessionStore } from "../../store/sessions";
import { isSubagentActive } from "../../types/session";
import { IconClose } from "../Icons/Icons";
import type { Subagent } from "../../types/session";

const EMPTY: Subagent[] = [];

interface SubagentBarProps {
  sessionId: string | null;
  inspectedSubagent: { sessionId: string; subagentId: string } | null;
  setInspectedSubagent: (v: { sessionId: string; subagentId: string } | null) => void;
}

export const SubagentBar = memo(function SubagentBar({
  sessionId,
  inspectedSubagent,
  setInspectedSubagent,
}: SubagentBarProps) {
  const subs = useSessionStore((s) =>
    sessionId ? s.subagents.get(sessionId) || EMPTY : EMPTY
  );
  const updateSubagent = useSessionStore((s) => s.updateSubagent);

  // Show all subs including dead (greyed out); cleared when new batch starts
  if (subs.length === 0) return null;

  return (
    <div className="subagent-bar">
      {subs.map((sub) => {
        const isActive = isSubagentActive(sub.state);
        const isIdle = sub.state === "idle";
        const isDead = sub.state === "dead";
        const isInterrupted = sub.state === "interrupted";
        const isSelected = inspectedSubagent?.subagentId === sub.id && inspectedSubagent?.sessionId === sessionId;
        // Reconstruct "ToolName: value" for display — only add prefix if text was actually stripped
        const lastMsgObj = sub.messages.length > 0 ? sub.messages[sub.messages.length - 1] : null;
        const lastMsg = lastMsgObj
          ? lastMsgObj.toolName && !lastMsgObj.text.startsWith(lastMsgObj.toolName)
            ? lastMsgObj.toolName + ": " + lastMsgObj.text.slice(0, 200)
            : lastMsgObj.text.slice(0, 200)
          : null;
        const metaParts: string[] = [];
        if (sub.agentType) metaParts.push(sub.agentType);
        if (sub.model) metaParts.push(sub.model.replace(/^claude-/, "").split("-")[0]);
        if (sub.totalToolUses != null) metaParts.push(`${sub.totalToolUses} tools`);
        if (sub.durationMs != null) metaParts.push(`${Math.round(sub.durationMs / 1000)}s`);
        return (
          <button
            key={sub.id}
            className={`subagent-card${isActive ? " subagent-active" : ""}${isIdle ? " subagent-idle" : ""}${isDead ? " subagent-dead" : ""}${isInterrupted ? " subagent-interrupted" : ""}${isSelected ? " subagent-selected" : ""}`}
            onClick={() => sessionId && setInspectedSubagent({ sessionId, subagentId: sub.id })}
            title={sub.description}
          >
            <span className={`tab-dot state-${sub.state}`} />
            <span className="subagent-label">
              <span className="subagent-name">{sub.description}</span>
              <span className="subagent-summary">
                {isActive && sub.currentAction ? sub.currentAction : lastMsg || ""}
              </span>
              {metaParts.length > 0 && (
                <span className="subagent-meta">{metaParts.join(" · ")}</span>
              )}
            </span>
            {!isActive && !isDead && (
              <span
                className="subagent-close"
                onClick={(e) => { e.stopPropagation(); sessionId && updateSubagent(sessionId, sub.id, { state: "dead" }); }}
                title="Dismiss"
              ><IconClose size={12} /></span>
            )}
          </button>
        );
      })}
    </div>
  );
});
