import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Subagent, SubagentMessage } from "../../types/session";
import { isSubagentActive } from "../../types/session";
import "./SubagentInspector.css";

interface SubagentInspectorProps {
  subagent: Subagent;
  onClose: () => void;
}

function getToolPreview(text: string): string {
  const firstLine = text.split("\n").find(line => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > 120 ? trimmed.slice(0, 120) + "\u2026" : trimmed;
}

// [IN-08] [TR-12] Tool block collapse: React.memo, collapsed by default, click to expand
const MessageBlock = memo(function MessageBlock({ msg, defaultExpanded }: { msg: SubagentMessage; defaultExpanded: boolean }) {
  const [collapsed, setCollapsed] = useState(!defaultExpanded);

  if (msg.role === "assistant") {
    return (
      <div className="inspector-msg inspector-msg-assistant">
        <div className="inspector-msg-md"><ReactMarkdown>{msg.text}</ReactMarkdown></div>
      </div>
    );
  }

  const label = msg.toolName === "result"
    ? <span className="inspector-tool-result-label">result</span>
    : msg.toolName
      ? <span className="inspector-tool-name">{msg.toolName}</span>
      : null;

  return (
    <div
      className={`inspector-msg inspector-msg-tool${collapsed ? " inspector-msg-tool-collapsed" : ""}`}
      onClick={() => setCollapsed(c => !c)}
    >
      <div className="inspector-tool-header">
        <span className="inspector-tool-toggle">{collapsed ? "\u25b8" : "\u25be"}</span>
        {label}
        {collapsed && <span className="inspector-tool-preview">{getToolPreview(msg.text)}</span>}
      </div>
      {!collapsed && <pre className="inspector-msg-text">{msg.text}</pre>}
    </div>
  );
}, (prev, next) => prev.msg === next.msg);

export function SubagentInspector({ subagent, onClose }: SubagentInspectorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(subagent.messages.length);

  // Scroll to bottom on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (subagent.messages.length > prevLenRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = subagent.messages.length;
  }, [subagent.messages.length]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const isActive = isSubagentActive(subagent.state);
  const lastToolIndex = isActive
    ? subagent.messages.reduce((acc, m, idx) => m.role === "tool" ? idx : acc, -1)
    : -1;

  return (
    <div className="inspector-overlay">
      <div className="inspector-header">
        <span className="inspector-header-desc">
          {(subagent.subagentType || subagent.agentType) && <span className="inspector-agent-type">{subagent.subagentType || subagent.agentType}</span>}
          {subagent.isAsync && <span className="inspector-async-badge">async</span>}
          {subagent.description}
        </span>
        <span className="inspector-header-meta">
          {subagent.state}
          {subagent.model && ` · ${subagent.model.replace(/^claude-/, "").split("-")[0]}`}
          {subagent.totalToolUses != null && ` · ${subagent.totalToolUses} tools`}
          {subagent.durationMs != null && ` · ${Math.round(subagent.durationMs / 1000)}s`}
          {subagent.messages.length > 0 && ` · ${subagent.messages.length} msgs`}
        </span>
        <button className="inspector-header-close" onClick={onClose}>×</button>
      </div>
      <div className="inspector-messages" ref={scrollRef}>
        {subagent.messages.length === 0 ? (
          <div className="inspector-empty">
            {subagent.state === "dead" || subagent.state === "idle"
              ? "No conversation data captured."
              : "Waiting for subagent output..."}
          </div>
        ) : (
          subagent.messages.map((msg, i) => (
            <MessageBlock key={i} msg={msg} defaultExpanded={msg.role === "assistant" || i === lastToolIndex} />
          ))
        )}
      </div>
    </div>
  );
}
