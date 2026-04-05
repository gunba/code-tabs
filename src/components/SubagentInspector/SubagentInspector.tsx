import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Subagent, SubagentMessage } from "../../types/session";
import { isSubagentActive } from "../../types/session";
import { splitFilePath } from "../../lib/diffParser";
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

// ── Tool-specific renderers ──

function FileHeader({ toolName, filePath }: { toolName: string; filePath: string }) {
  const { dir, name } = splitFilePath(filePath);
  return (
    <div className="inspector-tool-file-header">
      <span className="inspector-tool-file-tool">{toolName}</span>
      <span className="inspector-tool-file-path">
        <span className="inspector-tool-file-dir">{dir}</span>
        <span className="inspector-tool-file-name">{name}</span>
      </span>
    </div>
  );
}

function EditRenderer({ msg }: { msg: SubagentMessage }) {
  const input = msg.toolInput;
  if (!input) return null;
  const filePath = String(input.file_path || "");
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  const oldLines = oldStr ? oldStr.replace(/\n$/, "").split("\n") : [];
  const newLines = newStr ? newStr.replace(/\n$/, "").split("\n") : [];
  const removed = oldLines.length;
  const added = newLines.length;

  return (
    <div className="inspector-edit-block">
      <FileHeader toolName="Edit" filePath={filePath} />
      <div className="inspector-edit-summary">
        {added > 0 && <span className="inspector-edit-added">+{added}</span>}
        {removed > 0 && <span className="inspector-edit-removed">-{removed}</span>}
      </div>
      <div className="inspector-diff">
        {oldStr && oldLines.map((line, i) => (
          <div key={`d${i}`} className="inspector-diff-line inspector-diff-del">
            <span className="inspector-diff-prefix">-</span>
            <span className="inspector-diff-content">{line}</span>
          </div>
        ))}
        {newStr && newLines.map((line, i) => (
          <div key={`a${i}`} className="inspector-diff-line inspector-diff-add">
            <span className="inspector-diff-prefix">+</span>
            <span className="inspector-diff-content">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BashRenderer({ msg }: { msg: SubagentMessage }) {
  const input = msg.toolInput;
  const command = input ? String(input.command || msg.text) : msg.text;
  const description = input?.description ? String(input.description) : null;
  return (
    <div className="inspector-bash-block">
      <FileHeader toolName="Bash" filePath={description || command.slice(0, 60)} />
      <div className="inspector-bash-cmd">
        <span className="inspector-bash-prompt">$</span>
        <span className="inspector-bash-text">{command}</span>
      </div>
    </div>
  );
}

function FileToolRenderer({ msg, toolName }: { msg: SubagentMessage; toolName: string }) {
  const input = msg.toolInput;
  const filePath = input ? String(input.file_path || input.pattern || msg.text) : msg.text;
  return (
    <div className="inspector-file-block">
      <FileHeader toolName={toolName} filePath={filePath} />
    </div>
  );
}

function SearchRenderer({ msg, toolName }: { msg: SubagentMessage; toolName: string }) {
  const input = msg.toolInput;
  const pattern = input ? String(input.pattern || msg.text) : msg.text;
  const path = input?.path ? String(input.path) : null;
  return (
    <div className="inspector-search-block">
      <div className="inspector-tool-file-header">
        <span className="inspector-tool-file-tool">{toolName}</span>
        <span className="inspector-tool-file-path">
          <span className="inspector-tool-file-name">{pattern}</span>
          {path && <span className="inspector-tool-file-dir"> in {path}</span>}
        </span>
      </div>
    </div>
  );
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

  // Tool-specific rendering when structured input is available
  if (msg.toolInput) {
    const tn = msg.toolName;
    if (tn === "Edit") return <EditRenderer msg={msg} />;
    if (tn === "Bash") return <BashRenderer msg={msg} />;
    if (tn === "Read" || tn === "Write") return <FileToolRenderer msg={msg} toolName={tn} />;
    if (tn === "Grep" || tn === "Glob") return <SearchRenderer msg={msg} toolName={tn} />;
  }

  // Fallback: collapsible text block
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

  // Scroll to bottom on open
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

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
