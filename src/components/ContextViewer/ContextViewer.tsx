// [TA-04] ContextViewer: conversation context viewer — system prompt blocks + messages, opened from StatusBar
import { useState } from "react";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import type { SessionMetadata, SystemPromptBlock, CapturedMessage, CapturedContentBlock } from "../../types/session";
import "./ContextViewer.css";

interface ContextViewerProps {
  metadata: SessionMetadata;
  onClose: () => void;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function ContentBlockView({ block }: { block: CapturedContentBlock }) {
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
  return (
    <div className="context-tool-block">
      <span className="context-tool-badge">{block.type}</span>
    </div>
  );
}

function MessageCard({ message, index }: { message: CapturedMessage; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const textPreview = message.content.find((b) => b.type === "text")?.text?.slice(0, 120);
  const blockTypes = message.content.map((b) => b.type);
  const hasTools = blockTypes.some((t) => t === "tool_use" || t === "tool_result");

  return (
    <div className={`context-message${expanded ? " context-message-expanded" : ""}`}>
      <button className="context-message-header" onClick={() => setExpanded(!expanded)}>
        <span className="context-message-index">{index + 1}</span>
        <span className={`context-message-role context-role-${message.role}`}>{message.role}</span>
        {hasTools && <span className="context-message-tools">{blockTypes.filter((t) => t === "tool_use").length} tool{blockTypes.filter((t) => t === "tool_use").length !== 1 ? "s" : ""}</span>}
        {!expanded && textPreview && (
          <span className="context-message-preview">{textPreview}{(textPreview.length >= 120) ? "..." : ""}</span>
        )}
        <span className="context-message-blocks">{message.content.length} block{message.content.length !== 1 ? "s" : ""}</span>
        <span className="context-message-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
      </button>
      {expanded && (
        <div className="context-message-body">
          {message.content.map((block, bi) => (
            <ContentBlockView key={bi} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ContextViewer({ metadata, onClose }: ContextViewerProps) {
  const blocks = metadata.capturedSystemBlocks;
  const text = metadata.capturedSystemPrompt;
  const messages = metadata.capturedMessages;
  const dbg = metadata.contextDebug;

  if (!text && !blocks && !messages?.length) {
    return (
      <ModalOverlay onClose={onClose} className="context-viewer-modal">
        <div className="context-viewer">
          <div className="context-viewer-header">
            <span className="context-viewer-title">Conversation Context</span>
            <button className="context-viewer-close" onClick={onClose}>Esc</button>
          </div>
          <div className="context-viewer-empty">No context captured yet.</div>
        </div>
      </ModalOverlay>
    );
  }

  // Find the cache boundary: last block with cacheControl
  const lastCachedIdx = blocks
    ? blocks.reduce((acc, b, i) => (b.cacheControl ? i : acc), -1)
    : -1;

  const totalChars = blocks
    ? blocks.reduce((sum, b) => sum + b.text.length, 0)
    : (text?.length ?? 0);

  const blockCount = blocks?.length ?? (text ? 1 : 0);

  // If we don't have structured blocks, treat the full text as one block
  const displayBlocks: SystemPromptBlock[] = blocks ?? (text ? [{ text }] : []);

  return (
    <ModalOverlay onClose={onClose} className="context-viewer-modal">
      <div className="context-viewer">
        {/* Header */}
        <div className="context-viewer-header">
          <span className="context-viewer-title">Conversation Context</span>
          <span className="context-viewer-stats">
            {totalChars.toLocaleString()} chars
            {blockCount > 1 && ` \u00B7 ${blockCount} blocks`}
            {messages && ` \u00B7 ${messages.length} messages`}
          </span>
          <button className="context-viewer-close" onClick={onClose}>Esc</button>
        </div>

        {/* Token summary */}
        {dbg && (
          <div className="context-viewer-tokens">
            <span className="context-token-item">
              <span className="context-token-label">Input</span>
              <span className="context-token-value">{formatTokenCount(dbg.inputTokens)}</span>
            </span>
            <span className="context-token-item">
              <span className="context-token-label">Cache Read</span>
              <span className="context-token-value context-token-cached">{formatTokenCount(dbg.cacheRead)}</span>
            </span>
            <span className="context-token-item">
              <span className="context-token-label">Cache Create</span>
              <span className="context-token-value">{formatTokenCount(dbg.cacheCreation)}</span>
            </span>
            <span className="context-token-item">
              <span className="context-token-label">Total</span>
              <span className="context-token-value">{formatTokenCount(dbg.totalContextTokens)}</span>
            </span>
          </div>
        )}

        {/* Content */}
        <div className="context-viewer-content">
          {/* System prompt section */}
          {displayBlocks.length > 0 && (
            <div className="context-section">
              <div className="context-section-header">
                <span className="context-section-title">System Prompt</span>
                <span className="context-section-badge">{totalChars.toLocaleString()} chars</span>
              </div>
              {displayBlocks.map((block, i) => (
                <div key={i}>
                  <div className="context-block">
                    <div className="context-block-header">
                      <span className="context-block-label">Block {i + 1}</span>
                      <span className="context-block-size">{block.text.length.toLocaleString()} chars</span>
                      {block.cacheControl && (
                        <span className="context-block-cache-badge">cached</span>
                      )}
                    </div>
                    <pre className="context-block-text">{block.text}</pre>
                  </div>
                  {/* Cache boundary after the last cached block */}
                  {i === lastCachedIdx && i < displayBlocks.length - 1 && (
                    <div className="context-cache-boundary">
                      <span className="context-cache-boundary-line" />
                      <span className="context-cache-boundary-label">Cache boundary — content below not cached</span>
                      <span className="context-cache-boundary-line" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Messages section */}
          {messages && messages.length > 0 && (
            <div className="context-section">
              <div className="context-section-header">
                <span className="context-section-title">Messages</span>
                <span className="context-section-badge">{messages.length} messages</span>
              </div>
              <div className="context-messages-list">
                {messages.map((msg, i) => (
                  <MessageCard key={i} message={msg} index={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
