// [TA-04] ContextViewer: system prompt block viewer with cache boundary, opened from StatusBar
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import type { SessionMetadata, SystemPromptBlock } from "../../types/session";
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

export function ContextViewer({ metadata, onClose }: ContextViewerProps) {
  const blocks = metadata.capturedSystemBlocks;
  const text = metadata.capturedSystemPrompt;
  const dbg = metadata.contextDebug;

  if (!text && !blocks) {
    return (
      <ModalOverlay onClose={onClose} className="context-viewer-modal">
        <div className="context-viewer">
          <div className="context-viewer-header">
            <span className="context-viewer-title">System Prompt Context</span>
            <button className="context-viewer-close" onClick={onClose}>Esc</button>
          </div>
          <div className="context-viewer-empty">No system prompt captured yet.</div>
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
          <span className="context-viewer-title">System Prompt Context</span>
          <span className="context-viewer-stats">
            {totalChars.toLocaleString()} chars
            {blockCount > 1 && ` \u00B7 ${blockCount} blocks`}
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
              <span className="context-token-value">{formatTokenCount(dbg.totalContextTokens)} / {formatTokenCount(dbg.windowSize)}</span>
            </span>
          </div>
        )}

        {/* Block content */}
        <div className="context-viewer-content">
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
      </div>
    </ModalOverlay>
  );
}
