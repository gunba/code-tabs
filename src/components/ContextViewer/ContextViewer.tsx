// [TA-04] ContextViewer: conversation context viewer — unified list with per-subagent tabs
import { useCallback, useMemo, useState } from "react";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { formatTokenCount } from "../../lib/claude";
import { buildMainTabEntries, buildSubagentTabs } from "../../lib/contextProjection";
import type { UnifiedEntry, SubagentTab } from "../../lib/contextProjection";
import type { SessionMetadata, SystemPromptBlock, CapturedContentBlock, Subagent, SubagentMessage } from "../../types/session";
import { IconClose } from "../Icons/Icons";
import "./ContextViewer.css";

interface ContextViewerProps {
  metadata: SessionMetadata;
  subagents?: Subagent[];
  onClose: () => void;
}

// ── Content block renderer ──────────────────────────────

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
  return (
    <div className="context-tool-block">
      <span className="context-tool-badge">{block.type}</span>
    </div>
  );
}

// ── System block entry ──────────────────────────────────

function SystemBlockEntry({ block, index, expanded, onToggle }: {
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

// ── Message entry ───────────────────────────────────────

export function MessageEntry({ message, index, expanded, onToggle }: {
  message: { role: string; content: CapturedContentBlock[] };
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const textPreview = message.content.find((b) => b.type === "text")?.text?.slice(0, 120);
  const blockTypes = message.content.map((b) => b.type);
  const hasTools = blockTypes.some((t) => t === "tool_use" || t === "tool_result");

  return (
    <div className="context-entry">
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

// ── Subagent conversation message renderer ─────────────

function SubagentMessageEntry({ msg, expanded, onToggle }: {
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
  // Tool message
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

// ── Subagent tab content ────────────────────────────────

function SubagentTabContent({ tab, messages, expandedSet, onToggle }: {
  tab: SubagentTab;
  messages?: SubagentMessage[];
  expandedSet: Set<string>;
  onToggle: (key: string) => void;
}) {
  const promptKey = `${tab.id}:prompt`;
  const resultKey = `${tab.id}:result`;

  return (
    <div className="context-unified-list">
      <div className="context-entry">
        <button className="context-entry-header" onClick={() => onToggle(promptKey)}>
          <span className="context-entry-role context-role-system">prompt</span>
          <span className="context-entry-meta">{tab.promptText.length.toLocaleString()} chars</span>
          {!expandedSet.has(promptKey) && (
            <span className="context-entry-preview">{tab.promptText.slice(0, 120)}{tab.promptText.length > 120 ? "..." : ""}</span>
          )}
          <span className="context-entry-chevron">{expandedSet.has(promptKey) ? "\u25BC" : "\u25B6"}</span>
        </button>
        {expandedSet.has(promptKey) && (
          <div className="context-entry-body">
            <pre className="context-block-text">{tab.promptText}</pre>
          </div>
        )}
      </div>

      {/* Subagent conversation from TAP sidechain data */}
      {messages && messages.length > 0 && (
        <>
          <div className="context-subagent-conversation-header">
            <span className="context-entry-meta">{messages.length} sidechain messages</span>
          </div>
          {messages.map((msg, i) => {
            const msgKey = `${tab.id}:msg-${i}`;
            return (
              <SubagentMessageEntry
                key={msgKey}
                msg={msg}
                expanded={expandedSet.has(msgKey)}
                onToggle={() => onToggle(msgKey)}
              />
            );
          })}
        </>
      )}

      {tab.resultText != null ? (
        <div className="context-entry">
          <button className="context-entry-header" onClick={() => onToggle(resultKey)}>
            <span className="context-entry-role context-role-assistant">result</span>
            <span className="context-entry-meta">{tab.resultText.length.toLocaleString()} chars</span>
            {!expandedSet.has(resultKey) && (
              <span className="context-entry-preview">{tab.resultText.slice(0, 120)}{tab.resultText.length > 120 ? "..." : ""}</span>
            )}
            <span className="context-entry-chevron">{expandedSet.has(resultKey) ? "\u25BC" : "\u25B6"}</span>
          </button>
          {expandedSet.has(resultKey) && (
            <div className="context-entry-body">
              <pre className="context-block-text">{tab.resultText}</pre>
            </div>
          )}
        </div>
      ) : (
        <div className="context-subagent-pending">Pending...</div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────

export function ContextViewer({ metadata, subagents, onClose }: ContextViewerProps) {
  const blocks = metadata.capturedSystemBlocks;
  const text = metadata.capturedSystemPrompt;
  const messages = metadata.capturedMessages;
  const dbg = metadata.contextDebug;

  const [activeTab, setActiveTab] = useState("main");
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());

  // Preserve unstructured-system fallback
  const displayBlocks: SystemPromptBlock[] = blocks ?? (text ? [{ text }] : []);

  const lastCachedIdx = displayBlocks.reduce((acc, b, i) => (b.cacheControl ? i : acc), -1);

  const totalChars = displayBlocks.reduce((sum, b) => sum + b.text.length, 0);

  // Memoize projections
  const mainEntries = useMemo(
    () => buildMainTabEntries(displayBlocks, messages, lastCachedIdx),
    [displayBlocks, messages, lastCachedIdx],
  );

  const subagentTabs = useMemo(
    () => buildSubagentTabs(messages),
    [messages],
  );

  // Build a map from subagent tab id to its sidechain messages.
  // Also index by description prefix so capturedMessages tabs (keyed by tool_use.id)
  // can find TAP subagents (keyed by agentId) — the IDs use different namespaces.
  const subagentMessageMap = useMemo(() => {
    const map = new Map<string, SubagentMessage[]>();
    if (!subagents) return map;
    for (const sub of subagents) {
      if (sub.messages.length > 0) {
        map.set(sub.id, sub.messages);
        // Description-based bridge key for cross-namespace matching
        map.set("desc:" + sub.description, sub.messages);
      }
    }
    return map;
  }, [subagents]);

  /** Look up sidechain messages for a subagent tab: try by ID first, then by description+prompt. */
  const getTabMessages = useCallback((tab: SubagentTab): SubagentMessage[] | undefined => {
    // Direct ID match (same namespace)
    const byId = subagentMessageMap.get(tab.id);
    if (byId) return byId;
    // Cross-namespace: description prefix match, disambiguated by prompt text
    const byDesc = subagentMessageMap.get("desc:" + tab.label.replace(/\u2026$/, ""));
    if (byDesc) return byDesc;
    const prefix = tab.label.replace(/\u2026$/, "");
    const candidates = (subagents ?? []).filter(sub => sub.description.startsWith(prefix) && sub.messages.length > 0);
    if (candidates.length === 1) return candidates[0].messages;
    return candidates.find(sub => sub.promptText && sub.promptText === tab.promptText)?.messages;
  }, [subagentMessageMap, subagents]);

  // Ensure activeTab is valid
  const validTab = activeTab === "main" || subagentTabs.some(t => t.id === activeTab)
    ? activeTab
    : "main";

  // Keys for current tab (for Expand All)
  const currentKeys = useMemo(() => {
    if (validTab === "main") {
      return mainEntries
        .filter(e => e.kind !== "cache-boundary")
        .map(e => e.kind === "system" ? `main:sys-${e.index}` : `main:msg-${(e as Extract<UnifiedEntry, { kind: "message" }>).index}`);
    }
    const tab = subagentTabs.find(t => t.id === validTab);
    if (!tab) return [];
    const keys = [`${tab.id}:prompt`];
    const msgs = getTabMessages(tab);
    if (msgs) {
      for (let i = 0; i < msgs.length; i++) keys.push(`${tab.id}:msg-${i}`);
    }
    if (tab.resultText != null) keys.push(`${tab.id}:result`);
    return keys;
  }, [validTab, mainEntries, subagentTabs, getTabMessages]);

  const allExpanded = currentKeys.length > 0 && currentKeys.every(k => expandedSet.has(k));

  function toggleAll() {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (allExpanded) {
        for (const k of currentKeys) next.delete(k);
      } else {
        for (const k of currentKeys) next.add(k);
      }
      return next;
    });
  }

  function toggleEntry(key: string) {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (!text && !blocks && !messages?.length) {
    return (
      <ModalOverlay onClose={onClose} className="context-viewer-modal">
        <div className="context-viewer">
          <div className="context-viewer-header">
            <span className="context-viewer-title">Conversation Context</span>
            <button className="context-viewer-close" onClick={onClose} title="Close (Esc)" aria-label="Close"><IconClose size={14} /></button>
          </div>
          <div className="context-viewer-empty">No context captured yet.</div>
        </div>
      </ModalOverlay>
    );
  }

  return (
    <ModalOverlay onClose={onClose} className="context-viewer-modal">
      <div className="context-viewer">
        {/* Header */}
        <div className="context-viewer-header">
          <span className="context-viewer-title">Conversation Context</span>
          <span className="context-viewer-stats">
            {totalChars.toLocaleString()} chars
            {displayBlocks.length > 1 && ` \u00B7 ${displayBlocks.length} blocks`}
            {messages && ` \u00B7 ${messages.length} messages`}
          </span>
          <div className="context-viewer-controls">
            <button className="context-viewer-toggle" onClick={toggleAll}>
              {allExpanded ? "Collapse All" : "Expand All"}
            </button>
          </div>
          <button className="context-viewer-close" onClick={onClose} title="Close (Esc)" aria-label="Close"><IconClose size={14} /></button>
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

        {/* Tab bar (only when subagent tabs exist) */}
        {subagentTabs.length > 0 && (
          <div className="context-tab-bar">
            <button
              className={`context-tab${validTab === "main" ? " active" : ""}`}
              onClick={() => setActiveTab("main")}
            >
              Main Agent
            </button>
            {subagentTabs.map(tab => (
              <button
                key={tab.id}
                className={`context-tab${validTab === tab.id ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                title={tab.label}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="context-viewer-content">
          {validTab === "main" ? (
            <div className="context-unified-list">
              {mainEntries.map((entry, i) => {
                if (entry.kind === "cache-boundary") {
                  return (
                    <div key={`cb-${i}`} className="context-cache-boundary">
                      <span className="context-cache-boundary-line" />
                      <span className="context-cache-boundary-label">Cache boundary — content below not cached</span>
                      <span className="context-cache-boundary-line" />
                    </div>
                  );
                }
                if (entry.kind === "system") {
                  const key = `main:sys-${entry.index}`;
                  return (
                    <SystemBlockEntry
                      key={key}
                      block={entry.block}
                      index={entry.index}
                      expanded={expandedSet.has(key)}
                      onToggle={() => toggleEntry(key)}
                    />
                  );
                }
                // message
                const key = `main:msg-${entry.index}`;
                return (
                  <MessageEntry
                    key={key}
                    message={entry.message}
                    index={entry.index}
                    expanded={expandedSet.has(key)}
                    onToggle={() => toggleEntry(key)}
                  />
                );
              })}
            </div>
          ) : (
            (() => {
              const tab = subagentTabs.find(t => t.id === validTab);
              return tab ? (
                <SubagentTabContent
                  tab={tab}
                  messages={getTabMessages(tab)}
                  expandedSet={expandedSet}
                  onToggle={toggleEntry}
                />
              ) : null;
            })()
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
