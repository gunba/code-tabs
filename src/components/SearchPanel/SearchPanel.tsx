import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/sessions";
import { useRuntimeStore } from "../../store/runtime";
import { sessionColor } from "../../lib/claude";
import { dirToTabName } from "../../lib/paths";
import { validateRegex } from "../../lib/searchBuffers";
import { scrollTuiToText } from "../../lib/tuiScrollSearch";
import { focusTerminal } from "../../lib/terminalRegistry";
import { dlog } from "../../lib/debugLog";
import "./SearchPanel.css";

interface JsonlMatch {
  sessionId: string;
  messageIndex: number;
  role: string;
  matchOffset: number;
  matchLength: number;
  snippet: string;
}

interface SessionGroup {
  sessionId: string;
  name: string;
  color: string;
  matches: JsonlMatch[];
}

const RESULT_LIMIT = 500;
const DEBOUNCE_MS = 250;
const SNIPPET_TRUNCATE = 300;

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState<JsonlMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [scrolling, setScrolling] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchGenRef = useRef(0);

  const sessions = useSessionStore((s) => s.sessions);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Stable searchable-scope key: changes when sessions are added/removed or
  // when their search-backed metadata becomes available.
  const searchableSessionScope = useMemo(
    () => sessions
      .filter((s) => !s.isMetaAgent)
      .map((s) => `${s.id}\0${s.config.sessionId ?? ""}\0${s.config.workingDir ?? ""}\0${s.state}`)
      .join("\u0001"),
    [sessions]
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Perform search via Rust IPC
  const executeSearch = useCallback(async () => {
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

    // Build session list for Rust command
    const sessionList = sessionsRef.current
      .filter(s => !s.isMetaAgent && s.state !== "dead" && s.config.sessionId && s.config.workingDir)
      .map(s => ({ sessionId: s.config.sessionId, workingDir: s.config.workingDir }));

    if (!sessionList.length) {
      setResults([]);
      setActiveIndex(-1);
      return;
    }

    const gen = ++searchGenRef.current;

    try {
      const matches = await invoke<JsonlMatch[]>("search_jsonl_files", {
        sessions: sessionList,
        query,
        caseSensitive,
        useRegex,
        limit: RESULT_LIMIT,
      });

      // Discard stale results
      if (gen !== searchGenRef.current) return;

      // Map Rust sessionId (Claude session ID) back to app session ID
      const claudeToApp = new Map<string, string>();
      for (const s of sessionsRef.current) {
        if (s.config.sessionId) claudeToApp.set(s.config.sessionId, s.id);
      }

      const mapped = matches.map(m => ({
        ...m,
        sessionId: claudeToApp.get(m.sessionId) ?? m.sessionId,
      }));

      setResults(mapped);
      setActiveIndex(mapped.length > 0 ? 0 : -1);
      useRuntimeStore.getState().markSearchExecuted();
      dlog("search", null, `Search "${query}" → ${mapped.length} matches across ${sessionList.length} sessions`);
    } catch (err) {
      if (gen !== searchGenRef.current) return;
      dlog("search", null, `Search error: ${err}`, "ERR");
      setResults([]);
      setActiveIndex(-1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, useRegex, searchableSessionScope]);

  // Debounce search on query/options change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(executeSearch, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [executeSearch]);

  // Group results by session
  const groups: SessionGroup[] = useMemo(() => {
    const map = new Map<string, JsonlMatch[]>();
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

  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const group of groups) {
      offsets.push(offset);
      offset += group.matches.length;
    }
    return offsets;
  }, [groups]);

  // Navigate to a result: switch tab, then scroll TUI
  const navigateToResult = useCallback(async (match: JsonlMatch) => {
    if (!sessionsRef.current.some(s => s.id === match.sessionId)) return;

    const session = sessionsRef.current.find(s => s.id === match.sessionId);
    if (!session || session.state === "dead") return;

    setActiveTab(match.sessionId);

    // Abort any in-progress scroll
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Extract a search phrase from the snippet for viewport matching.
    // Use the matched text plus surrounding context for reliable identification.
    const snippet = match.snippet;
    const start = match.matchOffset;
    const phraseEnd = Math.min(start + match.matchLength + 40, snippet.length);
    const phraseStart = Math.max(0, start - 20);
    const searchPhrase = snippet.slice(phraseStart, phraseEnd);

    if (!searchPhrase.trim()) return;

    setScrolling(true);

    // Wait for tab switch to render
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    await scrollTuiToText(match.sessionId, searchPhrase, controller.signal);
    if (!controller.signal.aborted) {
      setScrolling(false);
    }
  }, [setActiveTab]);

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

  const handleClear = useCallback(() => {
    searchGenRef.current += 1;
    abortRef.current?.abort();
    setScrolling(false);
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setRegexError(null);
    inputRef.current?.focus();
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      handleClear();
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
        const match = results[activeIndex];
        navigateToResult(match).then(() => focusTerminal(match.sessionId));
      }
      return;
    }
  }, [results, activeIndex, navigateToResult, handleClear]);

  // Abort scroll on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
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
        {scrolling && <span className="search-panel-scrolling">Scrolling...</span>}
      </div>

      <div className="search-panel-input-row">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations..."
          className={regexError ? "search-input-error" : ""}
          spellCheck={false}
        />
        <button
          type="button"
          className="search-panel-clear"
          onClick={handleClear}
          title="Clear search (Ctrl+L)"
          disabled={!query && !scrolling && !regexError}
        >
          Clear
        </button>
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
          <div className="search-panel-empty">Type to search across all conversations</div>
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
                  const snippet = match.snippet.length > SNIPPET_TRUNCATE
                    ? match.snippet.slice(0, SNIPPET_TRUNCATE) + "..."
                    : match.snippet;

                  // Highlight the match in the snippet
                  const mStart = Math.min(match.matchOffset, snippet.length);
                  const mEnd = Math.min(match.matchOffset + match.matchLength, snippet.length);
                  const before = snippet.slice(0, mStart);
                  const matched = snippet.slice(mStart, mEnd);
                  const after = snippet.slice(mEnd);

                  return (
                    <div
                      key={`${match.messageIndex}-${mi}`}
                      className={`search-result${idx === activeIndex ? " active" : ""}`}
                      onClick={() => setActiveIndex(idx)}
                      title={match.snippet}
                    >
                      <span className={`search-result-role search-result-role-${match.role}`}>
                        {match.role === "user" ? "U" : "A"}
                      </span>
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
