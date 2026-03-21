import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessions";
import type { ThinkingBlock } from "../../types/session";
import "./ThinkingPanel.css";

interface ThinkingPanelProps {
  sessionId: string;
  onClose: () => void;
}

const EMPTY_BLOCKS: ThinkingBlock[] = [];

function formatRelativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function ThinkingPanel({ sessionId, onClose }: ThinkingPanelProps) {
  const blocks = useSessionStore((s) => s.thinkingBlocks.get(sessionId) ?? EMPTY_BLOCKS);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(blocks.length);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [, setTick] = useState(0);

  // Refresh relative timestamps every 10s
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Scroll to bottom on mount and when new blocks arrive
  useEffect(() => {
    if (blocks.length >= prevLenRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = blocks.length;
  }, [blocks.length]);

  function toggleExpand(idx: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <div className="thinking-panel">
      <div className="thinking-panel-header">
        <span className="thinking-panel-title">Thinking</span>
        <span className="thinking-panel-count">{blocks.length}</span>
        <button className="thinking-panel-close" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="thinking-panel-body" ref={scrollRef}>
        {blocks.length === 0 ? (
          <div className="thinking-panel-empty">No thinking blocks yet</div>
        ) : (
          blocks.map((block, i) => {
            if (block.redacted) {
              return (
                <div key={i} className="thinking-block thinking-block-redacted">
                  <div className="thinking-block-ts">{formatRelativeTime(block.timestamp)}</div>
                  <div className="thinking-block-redacted-text">[redacted thinking]</div>
                </div>
              );
            }

            const isLong = block.text.length > 500;
            const isExpanded = expanded.has(i);
            const displayText = isLong && !isExpanded ? block.text.slice(0, 500) : block.text;

            return (
              <div key={i} className="thinking-block">
                <div className="thinking-block-ts">{formatRelativeTime(block.timestamp)}</div>
                <pre className="thinking-block-text">{displayText}</pre>
                {isLong && (
                  <button className="thinking-block-toggle" onClick={() => toggleExpand(i)}>
                    {isExpanded ? "[show less]" : "[show more]"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
