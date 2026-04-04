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
        <ReactMarkdown>{msg.text}</ReactMarkdown>
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

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="inspector-section-divider">
      <span className="inspector-section-line" />
      <span className="inspector-section-label">{label}</span>
      <span className="inspector-section-line" />
    </div>
  );
}

export function SubagentInspector({ subagent, onClose }: SubagentInspectorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(subagent.messages.length);
  const prevResultRef = useRef(subagent.resultText);
  const [promptCollapsed, setPromptCollapsed] = useState(!!subagent.resultText);

  const isActive = isSubagentActive(subagent.state);

  // Scroll to bottom on new messages (during active execution)
  useEffect(() => {
    if (subagent.messages.length > prevLenRef.current && scrollRef.current && isActive) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = subagent.messages.length;
  }, [subagent.messages.length, isActive]);

  // Scroll to result when it first appears
  useEffect(() => {
    if (subagent.resultText && !prevResultRef.current && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      setPromptCollapsed(true);
    }
    prevResultRef.current = subagent.resultText;
  }, [subagent.resultText]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const lastToolIndex = isActive
    ? subagent.messages.reduce((acc, m, idx) => m.role === "tool" ? idx : acc, -1)
    : -1;

  // Build metadata string
  const metaParts: string[] = [];
  const typeLabel = subagent.subagentType || subagent.agentType;
  if (typeLabel) metaParts.push(typeLabel);
  if (subagent.model) metaParts.push(subagent.model.replace(/^claude-/, "").split("-")[0]);
  if (subagent.totalToolUses != null) metaParts.push(`${subagent.totalToolUses} tools`);
  if (subagent.durationMs != null) metaParts.push(`${Math.round(subagent.durationMs / 1000)}s`);
  if (subagent.messages.length > 0) metaParts.push(`${subagent.messages.length} msgs`);

  return (
    <div className="inspector-overlay">
      <div className="inspector-header">
        <span className="inspector-header-status">
          {subagent.completed
            ? <span className="inspector-status-done">{"\u2713"}</span>
            : <span className={`inspector-status-dot state-${subagent.state}`} />
          }
        </span>
        <span className="inspector-header-desc">{subagent.description}</span>
        {metaParts.length > 0 && (
          <span className="inspector-header-meta">{metaParts.join(" \u00b7 ")}</span>
        )}
        <button className="inspector-header-close" onClick={onClose}>Esc</button>
      </div>

      <div className="inspector-body" ref={scrollRef}>
        {/* [TA-08] Terminal-style lifecycle viewer: prompt, conversation, result, and pending states. */}
        {/* Prompt section */}
        {subagent.promptText && (
          <>
            <div
              className="inspector-section-divider inspector-section-clickable"
              onClick={() => setPromptCollapsed(c => !c)}
            >
              <span className="inspector-section-line" />
              <span className="inspector-section-label">
                {promptCollapsed ? "\u25b8" : "\u25be"} Prompt
              </span>
              <span className="inspector-section-line" />
            </div>
            {!promptCollapsed && (
              <div className="inspector-prompt">
                <pre className="inspector-prompt-text">{subagent.promptText}</pre>
              </div>
            )}
          </>
        )}

        {/* Conversation section */}
        {subagent.messages.length > 0 && (
          <>
            <SectionDivider label="Conversation" />
            {subagent.messages.map((msg, i) => (
              <MessageBlock key={i} msg={msg} defaultExpanded={msg.role === "assistant" || i === lastToolIndex} />
            ))}
          </>
        )}

        {/* Result section */}
        {subagent.resultText ? (
          <div ref={resultRef}>
            <SectionDivider label="Result" />
            <div className="inspector-result">
              <ReactMarkdown>{subagent.resultText}</ReactMarkdown>
            </div>
          </div>
        ) : isActive ? (
          <div className="inspector-pending">
            <span className="inspector-pending-dots" />
          </div>
        ) : subagent.messages.length === 0 ? (
          <div className="inspector-empty">No conversation data captured.</div>
        ) : null}
      </div>
    </div>
  );
}
