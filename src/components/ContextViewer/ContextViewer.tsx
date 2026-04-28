// [TA-04] ContextViewer: conversation context viewer — unified list with per-subagent tabs
import { useCallback, useMemo, useState } from "react";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { formatTokenCount } from "../../lib/claude";
import { buildMainTabEntries, buildSubagentTabs } from "../../lib/contextProjection";
import type { SubagentTab } from "../../lib/contextProjection";
import { useExpandableSet } from "../../hooks/useExpandableSet";
import type { SessionMetadata, SystemPromptBlock, CliKind, Subagent, SubagentMessage } from "../../types/session";
import { IconClose } from "../Icons/Icons";
import { MessageEntry, SystemBlockEntry } from "./blocks";
import { SubagentTabContent } from "./SubagentTabContent";
import { useCodexMessages } from "./useCodexMessages";
import "./ContextViewer.css";

interface ContextViewerProps {
  metadata: SessionMetadata;
  subagents?: Subagent[];
  sessionId: string;
  cli: CliKind;
  onClose: () => void;
}

// ── Main component ──────────────────────────────────────

export function ContextViewer({ metadata, subagents, sessionId, cli, onClose }: ContextViewerProps) {
  const blocks = metadata.capturedSystemBlocks;
  const text = metadata.capturedSystemPrompt;
  const codexMessages = useCodexMessages(sessionId, cli);
  const messages = cli === "codex" ? codexMessages : metadata.capturedMessages;
  const dbg = metadata.contextDebug;

  const [activeTab, setActiveTab] = useState("main");

  // Preserve unstructured-system fallback
  const displayBlocks: SystemPromptBlock[] = blocks ?? (text ? [{ text }] : []);

  const lastCachedIdx = displayBlocks.reduce((acc, b, i) => (b.cacheControl ? i : acc), -1);

  const totalChars = displayBlocks.reduce((sum, b) => sum + b.text.length, 0);

  // Memoize projections
  const mainEntries = useMemo(
    () => buildMainTabEntries(displayBlocks, messages, lastCachedIdx),
    [displayBlocks, messages, lastCachedIdx],
  );

  const subagentTabs = useMemo(() => {
    const completedTabs = buildSubagentTabs(messages);
    if (!subagents || subagents.length === 0) return completedTabs;

    // Merge TAP-only subagents not already represented by capturedMessages tabs
    const matchedIds = new Set<string>();
    for (const sub of subagents) {
      for (const tab of completedTabs) {
        if (tab.promptText && tab.promptText === sub.promptText) {
          matchedIds.add(sub.id);
          break;
        }
        const prefix = tab.label.replace(/\u2026$/, "");
        if (sub.description.startsWith(prefix)) {
          matchedIds.add(sub.id);
          break;
        }
      }
    }

    const tapOnlyTabs: SubagentTab[] = [];
    for (const sub of subagents) {
      if (matchedIds.has(sub.id)) continue;
      const desc = sub.description || "Agent";
      tapOnlyTabs.push({
        id: sub.id,
        label: desc.length > 30 ? desc.slice(0, 30) + "\u2026" : desc,
        promptText: sub.promptText || "",
        resultText: sub.resultText || null,
      });
    }

    return [...completedTabs, ...tapOnlyTabs];
  }, [messages, subagents]);

  // Build sidechain-message maps by subagent id and description. CapturedMessages
  // tabs can be keyed by tool_use.id while TAP subagents use agentId.
  const subagentMessageMaps = useMemo(() => {
    const byId = new Map<string, SubagentMessage[]>();
    const byDesc = new Map<string, SubagentMessage[]>();
    if (!subagents) return { byId, byDesc };
    for (const sub of subagents) {
      if (sub.messages.length > 0) {
        byId.set(sub.id, sub.messages);
        byDesc.set(sub.description, sub.messages);
      }
    }
    return { byId, byDesc };
  }, [subagents]);

  /** Look up sidechain messages for a subagent tab: try by ID first, then by description+prompt. */
  const getTabMessages = useCallback((tab: SubagentTab): SubagentMessage[] | undefined => {
    // Direct ID match (same namespace)
    const byId = subagentMessageMaps.byId.get(tab.id);
    if (byId) return byId;
    // Cross-namespace: description prefix match, disambiguated by prompt text
    const byDesc = subagentMessageMaps.byDesc.get(tab.label.replace(/\u2026$/, ""));
    if (byDesc) return byDesc;
    const prefix = tab.label.replace(/\u2026$/, "");
    const candidates = (subagents ?? []).filter(sub => sub.description.startsWith(prefix) && sub.messages.length > 0);
    if (candidates.length === 1) return candidates[0].messages;
    return candidates.find(sub => sub.promptText && sub.promptText === tab.promptText)?.messages;
  }, [subagentMessageMaps, subagents]);

  // Ensure activeTab is valid
  const validTab = activeTab === "main" || subagentTabs.some(t => t.id === activeTab)
    ? activeTab
    : "main";

  const activeSubagentTab = useMemo(
    () => validTab === "main" ? null : subagentTabs.find(t => t.id === validTab) ?? null,
    [subagentTabs, validTab],
  );

  // Keys for current tab (for Expand All)
  const currentKeys = useMemo(() => {
    if (validTab === "main") {
      const keys: string[] = [];
      mainEntries.forEach((e, i) => {
        if (e.kind === "system") keys.push(`main:sys-${e.index}`);
        else if (e.kind === "message") keys.push(`main:msg-${e.index}`);
        else if (e.kind === "compaction-boundary") keys.push(`main:compact-${i}`);
      });
      return keys;
    }
    const tab = activeSubagentTab;
    if (!tab) return [];
    const keys = [`${tab.id}:prompt`];
    const msgs = getTabMessages(tab);
    if (msgs) {
      for (let i = 0; i < msgs.length; i++) keys.push(`${tab.id}:msg-${i}`);
    }
    if (tab.resultText != null) keys.push(`${tab.id}:result`);
    return keys;
  }, [validTab, mainEntries, activeSubagentTab, getTabMessages]);

  const { expandedSet, allExpanded, toggle: toggleEntry, toggleAll } = useExpandableSet(currentKeys);

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
                if (entry.kind === "compaction-boundary") {
                  const key = `main:compact-${i}`;
                  const isOpen = expandedSet.has(key);
                  return (
                    <div key={key} className="context-compaction-boundary">
                      <span className="context-cache-boundary-line" />
                      <span className="context-cache-boundary-label">Conversation compacted</span>
                      <span className="context-cache-boundary-line" />
                      <button className="context-viewer-toggle" onClick={() => toggleEntry(key)}>
                        {isOpen ? "Hide" : "Show"} summary
                      </button>
                      {isOpen && (
                        <pre className="context-block-text context-compaction-summary-body">{entry.summary}</pre>
                      )}
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
                    preCompaction={entry.preCompaction}
                  />
                );
              })}
            </div>
          ) : (
            activeSubagentTab && (
              <SubagentTabContent
                tab={activeSubagentTab}
                messages={getTabMessages(activeSubagentTab)}
                expandedSet={expandedSet}
                onToggle={toggleEntry}
              />
            )
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
