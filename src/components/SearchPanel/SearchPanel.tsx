import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessions";
import { sessionColor } from "../../lib/claude";
import { dirToTabName } from "../../lib/paths";
import { getSessionTranscript, highlightMatch, clearHighlight, scrollSessionToLine } from "../../lib/terminalRegistry";
import { searchBuffers, validateRegex, type SearchMatch } from "../../lib/searchBuffers";
import { IconClose } from "../Icons/Icons";
import { dlog } from "../../lib/debugLog";
import "./SearchPanel.css";

interface SearchPanelProps {
  onClose: () => void;
}

interface SessionGroup {
  sessionId: string;
  name: string;
  color: string;
  matches: SearchMatch[];
}

const RESULT_LIMIT = 500;
const DEBOUNCE_MS = 250;
const CONTEXT_TRUNCATE = 200;

// [TR-16] Cross-session terminal search panel (Ctrl+Shift+F)
export function SearchPanel({ onClose }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [regexError, setRegexError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevHighlightSession = useRef<string | null>(null);

  const sessions = useSessionStore((s) => s.sessions);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);

  // Ref for reading current sessions without triggering executeSearch recreation.
  // executeSearch only needs session IDs (to call getSessionTranscript), not full objects.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Stable scope key: only changes when sessions are added/removed (not on state/metadata churn).
  // Prevents session state transitions (idle/waiting/active) from re-triggering search.
  const sessionScope = useMemo(
    () => sessions.filter(s => !s.isMetaAgent).map(s => s.id).join('\0'),
    [sessions]
  );

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Perform search (debounced)
  const executeSearch = useCallback(() => {
    if (!query) {
      setResults([]);
      setActiveIndex(-1);
      setRegexError(null);
      return;
    }

    if (useRegex) {
      const err = validateRegex(query);
      if (err) {
        setRegexError(err);
        setResults([]);
        setActiveIndex(-1);
        return;
      }
    }
    setRegexError(null);

    const buffers: Array<{ id: string; text: string }> = [];
    for (const s of sessionsRef.current) {
      if (s.isMetaAgent) continue;
      const text = getSessionTranscript(s.id);
      if (text) buffers.push({ id: s.id, text });
    }

    const matches = searchBuffers(buffers, query, caseSensitive, useRegex, RESULT_LIMIT);
    setResults(matches);
    setActiveIndex(matches.length > 0 ? 0 : -1);
    dlog("search", null, `Search "${query}" → ${matches.length} matches across ${buffers.length} sessions`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, useRegex, sessionScope]);

  // Debounce search on query/options change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(executeSearch, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [executeSearch]);

  // Group results by session, with precomputed flat offsets
  const groups: SessionGroup[] = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const r of results) {
      let arr = map.get(r.sessionId);
      if (!arr) { arr = []; map.set(r.sessionId, arr); }
      arr.push(r);
    }

    const out: SessionGroup[] = [];
    for (const [sid, matches] of map) {
      const s = sessions.find((x) => x.id === sid);
      const name = s?.name || (s?.config.workingDir ? dirToTabName(s.config.workingDir) : sid.slice(0, 8));
      out.push({ sessionId: sid, name, color: sessionColor(sid), matches });
    }
    return out;
  }, [results, sessions]);

  // Precompute the flat offset for each group so the render doesn't mutate
  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const group of groups) {
      offsets.push(offset);
      offset += group.matches.length;
    }
    return offsets;
  }, [groups]);

  // Navigate to a specific result
  const navigateToResult = useCallback((match: SearchMatch) => {
    // Skip if session was closed while results are still displayed
    if (!sessionsRef.current.some(s => s.id === match.sessionId)) return;

    // Clear previous highlight
    if (prevHighlightSession.current && prevHighlightSession.current !== match.sessionId) {
      clearHighlight(prevHighlightSession.current);
    }

    // Switch tab
    setActiveTab(match.sessionId);
    prevHighlightSession.current = match.sessionId;

    // Defer scroll + highlight after tab layout reflow (double-rAF pattern)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollSessionToLine(match.sessionId, Math.max(0, match.lineIndex - 2));

      if (query) {
        highlightMatch(match.sessionId, match.lineIndex, match.matchStart, match.matchLength);
      }
    }));
  }, [query, setActiveTab]);

  // Navigate to active result when activeIndex changes
  useEffect(() => {
    if (activeIndex >= 0 && activeIndex < results.length) {
      navigateToResult(results[activeIndex]);
    }
  }, [activeIndex, results, navigateToResult]);

  // Scroll active result into view in the results list
  useEffect(() => {
    if (activeIndex < 0 || !bodyRef.current) return;
    const el = bodyRef.current.querySelector(".search-result.active");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (query) {
        setQuery("");
      } else {
        onClose();
      }
      return;
    }

    if (e.key === "ArrowDown" || (e.key === "F3" && !e.shiftKey)) {
      e.preventDefault();
      if (results.length > 0) {
        setActiveIndex((prev) => (prev + 1) % results.length);
      }
      return;
    }

    if (e.key === "ArrowUp" || (e.key === "F3" && e.shiftKey)) {
      e.preventDefault();
      if (results.length > 0) {
        setActiveIndex((prev) => (prev - 1 + results.length) % results.length);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < results.length) {
        navigateToResult(results[activeIndex]);
      }
      return;
    }
  }, [query, results, activeIndex, navigateToResult, onClose]);

  // Clean up highlights on unmount
  useEffect(() => {
    return () => {
      if (prevHighlightSession.current) {
        clearHighlight(prevHighlightSession.current);
      }
    };
  }, []);

  return (
    <div className="search-panel" onKeyDown={handleKeyDown}>
      <div className="search-panel-header">
        <span className="search-panel-title">Search</span>
        {results.length > 0 && (
          <span className="search-panel-count">
            {results.length >= RESULT_LIMIT ? `${RESULT_LIMIT}+` : results.length}
            {activeIndex >= 0 ? ` (${activeIndex + 1})` : ""}
          </span>
        )}
        <button className="search-panel-close" onClick={onClose} title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>

      <div className="search-panel-input-row">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all terminals..."
          className={regexError ? "search-input-error" : ""}
          spellCheck={false}
        />
        <button
          className={`search-panel-toggle${caseSensitive ? " active" : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Match case"
        >
          Aa
        </button>
        <button
          className={`search-panel-toggle${useRegex ? " active" : ""}`}
          onClick={() => setUseRegex((v) => !v)}
          title="Use regular expression"
        >
          .*
        </button>
      </div>

      {regexError && (
        <div className="search-panel-error">{regexError}</div>
      )}

      <div className="search-panel-body" ref={bodyRef}>
        {query && results.length === 0 && !regexError ? (
          <div className="search-panel-empty">No results</div>
        ) : !query ? (
          <div className="search-panel-empty">Type to search across all terminals</div>
        ) : (
          groups.map((group, gi) => {
            const baseOffset = groupOffsets[gi];
            return (
              <div key={group.sessionId}>
                <div className="search-group-header">
                  <span className="search-group-dot" style={{ background: group.color }} />
                  <span>{group.name}</span>
                  <span className="search-group-count">{group.matches.length}</span>
                </div>
                {group.matches.map((match, mi) => {
                  const idx = baseOffset + mi;
                  const text = match.lineText.length > CONTEXT_TRUNCATE
                    ? match.lineText.slice(0, CONTEXT_TRUNCATE) + "..."
                    : match.lineText;

                  // Highlight the match in the snippet
                  const before = text.slice(0, Math.min(match.matchStart, text.length));
                  const matched = text.slice(match.matchStart, Math.min(match.matchStart + match.matchLength, text.length));
                  const after = text.slice(Math.min(match.matchStart + match.matchLength, text.length));

                  return (
                    <div
                      key={`${match.lineIndex}-${mi}`}
                      className={`search-result${idx === activeIndex ? " active" : ""}`}
                      onClick={() => setActiveIndex(idx)}
                      title={match.lineText}
                    >
                      <span className="search-result-line">{match.lineIndex + 1}</span>
                      <span className="search-result-text">
                        {before}<mark>{matched}</mark>{after}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
