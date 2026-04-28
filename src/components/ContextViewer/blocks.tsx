import type { CapturedContentBlock, SubagentMessage, SystemPromptBlock } from "../../types/session";
import "./ContextViewer.css";

export function ContentBlockView({ block }: { block: CapturedContentBlock }) {
  if (block.type === "text") {
    return <pre className="context-block-text">{block.text}</pre>;
  }
  if (block.type === "tool_use") {
    return (
      <div className="context-tool-block">
        <span className="context-tool-badge">tool_use</span>
        <span className="context-tool-name">{block.name}</span>
        {block.input != null && (
          <pre className="context-tool-preview">{typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)}</pre>
        )}
      </div>
    );
  }
  if (block.type === "tool_result") {
    return (
      <div className="context-tool-block">
        <span className={`context-tool-badge${block.isError ? " context-tool-error" : ""}`}>
          tool_result{block.isError ? " (error)" : ""}
        </span>
        {block.text && <pre className="context-tool-preview">{block.text}</pre>}
      </div>
    );
  }
  if (block.type === "image") {
    return (
      <div className="context-tool-block">
        <span className="context-tool-badge">image</span>
        <span className="context-tool-name">{block.mediaType}</span>
      </div>
    );
  }
  if (block.type === "reasoning") {
    return (
      <div className="context-tool-block context-reasoning-block">
        <span className="context-tool-badge">reasoning</span>
        <span
          className="context-tool-name"
          title="The model thought here (encrypted, no plaintext)"
        >
          thinking…
        </span>
        {block.summary && block.summary.length > 0 && (
          <pre className="context-tool-preview">{block.summary.join("\n")}</pre>
        )}
      </div>
    );
  }
  if (block.type === "compaction_summary") {
    return <pre className="context-block-text">{block.text ?? ""}</pre>;
  }
  return (
    <div className="context-tool-block">
      <span className="context-tool-badge">{block.type}</span>
    </div>
  );
}

export function SystemBlockEntry({ block, index, expanded, onToggle }: {
  block: SystemPromptBlock;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const preview = block.text.slice(0, 100).replace(/\n/g, " ");
  return (
    <div className="context-entry">
      <button className="context-entry-header" onClick={onToggle}>
        <span className="context-entry-index">{index + 1}</span>
        <span className="context-entry-role context-role-system">system</span>
        <span className="context-entry-meta">{block.text.length.toLocaleString()} chars</span>
        {block.cacheControl && <span className="context-cache-badge">cached</span>}
        {!expanded && <span className="context-entry-preview">{preview}{preview.length >= 100 ? "..." : ""}</span>}
        <span className="context-entry-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
      </button>
      {expanded && (
        <div className="context-entry-body">
          <pre className="context-block-text">{block.text}</pre>
        </div>
      )}
    </div>
  );
}

export function MessageEntry({ message, index, expanded, onToggle, preCompaction }: {
  message: { role: string; content: CapturedContentBlock[] };
  index: number;
  expanded: boolean;
  onToggle: () => void;
  preCompaction?: boolean;
}) {
  const textPreview = message.content.find((b) => b.type === "text")?.text?.slice(0, 120);
  const blockTypes = message.content.map((b) => b.type);
  const hasTools = blockTypes.some((t) => t === "tool_use" || t === "tool_result");

  return (
    <div className={`context-entry${preCompaction ? " context-message-pre-compaction" : ""}`}>
      <button className="context-entry-header" onClick={onToggle}>
        <span className="context-entry-index">{index + 1}</span>
        <span className={`context-entry-role context-role-${message.role}`}>{message.role}</span>
        {hasTools && <span className="context-entry-meta">{blockTypes.filter((t) => t === "tool_use").length} tool{blockTypes.filter((t) => t === "tool_use").length !== 1 ? "s" : ""}</span>}
        {!expanded && textPreview && (
          <span className="context-entry-preview">{textPreview}{textPreview.length >= 120 ? "..." : ""}</span>
        )}
        <span className="context-entry-meta">{message.content.length} block{message.content.length !== 1 ? "s" : ""}</span>
        <span className="context-entry-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
      </button>
      {expanded && (
        <div className="context-entry-body">
          {message.content.map((block, bi) => (
            <ContentBlockView key={bi} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SubagentMessageEntry({ msg, expanded, onToggle }: {
  msg: SubagentMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (msg.role === "assistant") {
    const preview = msg.text.slice(0, 120);
    return (
      <div className="context-entry">
        <button className="context-entry-header" onClick={onToggle}>
          <span className="context-entry-role context-role-assistant">assistant</span>
          <span className="context-entry-meta">{msg.text.length.toLocaleString()} chars</span>
          {!expanded && <span className="context-entry-preview">{preview}{preview.length >= 120 ? "..." : ""}</span>}
          <span className="context-entry-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
        </button>
        {expanded && (
          <div className="context-entry-body">
            <pre className="context-block-text">{msg.text}</pre>
          </div>
        )}
      </div>
    );
  }

  const toolLabel = msg.toolName || "tool";
  const preview = msg.text.slice(0, 120);
  return (
    <div className="context-entry">
      <button className="context-entry-header" onClick={onToggle}>
        <span className="context-tool-badge">{toolLabel}</span>
        <span className="context-entry-meta">{msg.text.length.toLocaleString()} chars</span>
        {!expanded && <span className="context-entry-preview">{preview}{preview.length >= 120 ? "..." : ""}</span>}
        <span className="context-entry-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
      </button>
      {expanded && (
        <div className="context-entry-body">
          <pre className="context-tool-preview">{msg.text}</pre>
        </div>
      )}
    </div>
  );
}
