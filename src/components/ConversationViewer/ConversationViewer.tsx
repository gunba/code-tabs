import { useState, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { MessageEntry } from "../ContextViewer/ContextViewer";
import { IconClose } from "../Icons/Icons";
import type { CapturedMessage } from "../../types/session";
import "../ContextViewer/ContextViewer.css";
import "./ConversationViewer.css";

interface ConversationViewerProps {
  filePath: string;
  displayName: string | null;
  directory: string;
  onClose: () => void;
}

export function ConversationViewer({ filePath, displayName, directory, onClose }: ConversationViewerProps) {
  const [messages, setMessages] = useState<CapturedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<CapturedMessage[]>("read_conversation", { filePath });
        if (!cancelled) {
          setMessages(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  const toggleEntry = useCallback((key: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allKeys = useMemo(
    () => messages.map((_, i) => `cv-msg-${i}`),
    [messages],
  );

  const allExpanded = allKeys.length > 0 && allKeys.every((k) => expandedSet.has(k));

  const toggleAll = useCallback(() => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (allExpanded) {
        for (const k of allKeys) next.delete(k);
      } else {
        for (const k of allKeys) next.add(k);
      }
      return next;
    });
  }, [allExpanded, allKeys]);

  const title = displayName || directory.split(/[\\/]/).filter(Boolean).pop() || "Conversation";

  return (
    <ModalOverlay onClose={onClose} className="conversation-viewer-modal">
      <div className="conversation-viewer">
        <div className="conversation-viewer-header">
          <div className="conversation-viewer-title-area">
            <span className="conversation-viewer-title">{title}</span>
            <span className="conversation-viewer-dir">{directory}</span>
          </div>
          <div className="conversation-viewer-controls">
            {messages.length > 0 && (
              <button className="conversation-viewer-toggle" onClick={toggleAll}>
                {allExpanded ? "Collapse All" : "Expand All"}
              </button>
            )}
            <span className="conversation-viewer-stats">
              {messages.length} message{messages.length !== 1 ? "s" : ""}
            </span>
          </div>
          <button className="conversation-viewer-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="conversation-viewer-content">
          {loading && (
            <div className="conversation-viewer-empty">Loading conversation...</div>
          )}
          {error && (
            <div className="conversation-viewer-error">{error}</div>
          )}
          {!loading && !error && messages.length === 0 && (
            <div className="conversation-viewer-empty">No messages found in this conversation.</div>
          )}
          {!loading && !error && messages.length > 0 && (
            <div className="context-unified-list">
              {messages.map((msg, i) => {
                const key = `cv-msg-${i}`;
                return (
                  <MessageEntry
                    key={key}
                    message={msg}
                    index={i}
                    expanded={expandedSet.has(key)}
                    onToggle={() => toggleEntry(key)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
