import { useEffect, useRef } from "react";
import type { Subagent, SubagentMessage } from "../../types/session";
import "./SubagentInspector.css";

interface SubagentInspectorProps {
  subagent: Subagent;
  onClose: () => void;
}

function MessageBlock({ msg }: { msg: SubagentMessage }) {
  if (msg.role === "assistant") {
    return (
      <div className="inspector-msg inspector-msg-assistant">
        <pre className="inspector-msg-text">{msg.text}</pre>
      </div>
    );
  }

  return (
    <div className="inspector-msg inspector-msg-tool">
      {msg.toolName && msg.toolName !== "result" && (
        <span className="inspector-tool-name">{msg.toolName}</span>
      )}
      {msg.toolName === "result" && (
        <span className="inspector-tool-result-label">result</span>
      )}
      <pre className="inspector-msg-text">{msg.text}</pre>
    </div>
  );
}

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

  return (
    <div className="inspector-overlay">
      <div className="inspector-messages" ref={scrollRef}>
        {subagent.messages.length === 0 ? (
          <div className="inspector-empty">
            {subagent.state === "dead" || subagent.state === "idle"
              ? "No conversation data captured."
              : "Waiting for subagent output..."}
          </div>
        ) : (
          subagent.messages.map((msg, i) => (
            <MessageBlock key={i} msg={msg} />
          ))
        )}
      </div>
    </div>
  );
}
