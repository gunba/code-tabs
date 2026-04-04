import { describe, it, expect } from "vitest";
import { normalizeForFilter } from "../paths";
import type { PastSession, ContentSearchMatch } from "../../types/session";

// ── Helpers ──────────────────────────────────────────────────────────

function mkPastSession(overrides: Partial<PastSession> = {}): PastSession {
  return {
    id: "session-abc123",
    path: "C:/Users/jorda/.claude/projects/proj/session-abc123.jsonl",
    directory: "C:/Users/jorda/Projects/my-app",
    lastModified: "2026-03-22T10:00:00Z",
    sizeBytes: 4096,
    firstMessage: "Fix the login bug",
    lastMessage: "Done, all tests pass",
    parentId: null,
    model: "claude-sonnet-4-5-20250514",
    filePath: "C:/Users/jorda/.claude/projects/proj/session-abc123.jsonl",
    dirExists: true,
    ...overrides,
  };
}

// ── Filter matching logic (mirrors ResumePicker lines 143-158) ──────
// This replicates the component's filter function as a pure function
// so we can test it without rendering React.

function matchesFilter(
  ps: PastSession,
  dirFilter: string,
  sessionNames: Record<string, string>
): boolean {
  if (!dirFilter.trim()) return true;
  const filterNorm = normalizeForFilter(dirFilter);
  const dirNorm = normalizeForFilter(ps.directory);
  if (dirNorm.includes(filterNorm) || filterNorm.includes(dirNorm)) return true;
  const name = sessionNames[ps.id];
  if (name && normalizeForFilter(name).includes(filterNorm)) return true;
  return false;
}

// ── Name resolution logic (mirrors ResumePicker resumeById, line 274) ──

function resolveResumeName(
  ps: PastSession,
  displayName: string | null | undefined,
  sessionNames: Record<string, string>
): string {
  return displayName || sessionNames[ps.id] || ps.path;
}

// ── Chain displayName resolution (mirrors ResumePicker lines 203-209) ──

interface ChainMember {
  id: string;
}

function resolveChainDisplayName(
  members: ChainMember[],
  sessionNames: Record<string, string>
): string | null {
  for (const m of members) {
    if (sessionNames[m.id]) {
      return sessionNames[m.id];
    }
  }
  return null;
}

// ── Tests: Filter matching by session name ──────────────────────────

describe("ResumePicker filter: name-search", () => {
  const session = mkPastSession({ id: "sess-1", directory: "C:/Users/jorda/Projects/my-app" });

  it("matches when filter is in session name", () => {
    const names = { "sess-1": "Login Bug Fix" };
    expect(matchesFilter(session, "login", names)).toBe(true);
  });

  it("matches session name case-insensitively", () => {
    const names = { "sess-1": "Login Bug Fix" };
    expect(matchesFilter(session, "LOGIN BUG", names)).toBe(true);
  });

  it("matches partial session name", () => {
    const names = { "sess-1": "refactor-authentication-module" };
    expect(matchesFilter(session, "auth", names)).toBe(true);
  });

  it("does not match when filter is not in name or directory", () => {
    const names = { "sess-1": "Login Bug Fix" };
    expect(matchesFilter(session, "database-migration", names)).toBe(false);
  });

  it("matches directory even when session has no name", () => {
    expect(matchesFilter(session, "my-app", {})).toBe(true);
  });

  it("matches directory when session name does not match", () => {
    const names = { "sess-1": "unrelated" };
    expect(matchesFilter(session, "my-app", names)).toBe(true);
  });

  it("matches name even when directory does not match", () => {
    const session2 = mkPastSession({ id: "s2", directory: "C:/totally/different/path" });
    const names = { s2: "important-task" };
    expect(matchesFilter(session2, "important", names)).toBe(true);
  });

  it("skips name check when sessionNames has no entry for this session", () => {
    const names = { "other-session": "Some Name" };
    expect(matchesFilter(session, "some-name", names)).toBe(false);
  });

  it("returns true for empty filter", () => {
    expect(matchesFilter(session, "", {})).toBe(true);
    expect(matchesFilter(session, "  ", {})).toBe(true);
  });

  it("normalizes special characters in session names", () => {
    const names = { "sess-1": "Fix Bug #42 (urgent)" };
    // normalizeForFilter turns "#42 (urgent)" into "-42--urgent-"
    expect(matchesFilter(session, "42", names)).toBe(true);
    expect(matchesFilter(session, "urgent", names)).toBe(true);
  });

  it("handles session name with periods (e.g., file extensions)", () => {
    const names = { "sess-1": "update config.json schema" };
    expect(matchesFilter(session, "config", names)).toBe(true);
    expect(matchesFilter(session, "json", names)).toBe(true);
  });
});

// ── Tests: Name resolution priority ─────────────────────────────────

describe("ResumePicker resumeById: name resolution", () => {
  const ps = mkPastSession({ id: "sess-1" });

  it("uses displayName when provided", () => {
    const names = { "sess-1": "stored name" };
    expect(resolveResumeName(ps, "explicit name", names)).toBe("explicit name");
  });

  it("falls back to sessionNames when displayName is null", () => {
    const names = { "sess-1": "stored name" };
    expect(resolveResumeName(ps, null, names)).toBe("stored name");
  });

  it("falls back to sessionNames when displayName is undefined", () => {
    const names = { "sess-1": "stored name" };
    expect(resolveResumeName(ps, undefined, names)).toBe("stored name");
  });

  it("falls back to ps.path when both displayName and sessionNames are absent", () => {
    expect(resolveResumeName(ps, null, {})).toBe(ps.path);
  });

  it("falls back to ps.path when displayName is empty string", () => {
    // Empty string is falsy, so falls through
    expect(resolveResumeName(ps, "", {})).toBe(ps.path);
  });

  it("prefers displayName over sessionNames even when both exist", () => {
    const names = { "sess-1": "stored" };
    expect(resolveResumeName(ps, "explicit", names)).toBe("explicit");
  });

  it("prefers sessionNames over ps.path when displayName is absent", () => {
    const names = { "sess-1": "named session" };
    expect(resolveResumeName(ps, null, names)).toBe("named session");
  });
});

// ── Tests: Chain displayName resolution ─────────────────────────────

describe("ResumePicker chain: displayName resolution", () => {
  it("returns name from first member that has an entry", () => {
    const members = [{ id: "latest" }, { id: "middle" }, { id: "oldest" }];
    const names = { middle: "My Task", oldest: "Old Name" };
    expect(resolveChainDisplayName(members, names)).toBe("My Task");
  });

  it("returns null when no member has a name", () => {
    const members = [{ id: "a" }, { id: "b" }];
    expect(resolveChainDisplayName(members, {})).toBeNull();
  });

  it("returns first member's name when all have names", () => {
    const members = [{ id: "a" }, { id: "b" }];
    const names = { a: "Name A", b: "Name B" };
    expect(resolveChainDisplayName(members, names)).toBe("Name A");
  });

  it("handles single-member chain with name", () => {
    const members = [{ id: "solo" }];
    const names = { solo: "Solo Session" };
    expect(resolveChainDisplayName(members, names)).toBe("Solo Session");
  });

  it("handles single-member chain without name", () => {
    const members = [{ id: "solo" }];
    expect(resolveChainDisplayName(members, {})).toBeNull();
  });

  it("skips members with empty-string names (empty string is falsy)", () => {
    // In sessionNames, an empty string entry would not be set — but
    // if it were, the component's `if (sessionNames[m.id])` guard
    // would skip it since "" is falsy.
    const members = [{ id: "a" }, { id: "b" }];
    const names: Record<string, string> = { a: "", b: "Real Name" };
    expect(resolveChainDisplayName(members, names)).toBe("Real Name");
  });
});

// ── Tests: normalizeForFilter with session-name patterns ────────────

describe("normalizeForFilter: session name patterns", () => {
  it("normalizes a human-readable session name", () => {
    expect(normalizeForFilter("Fix Login Bug")).toBe("fix-login-bug");
  });

  it("normalizes name with special chars", () => {
    expect(normalizeForFilter("bug #123: fix auth")).toBe("bug--123--fix-auth");
  });

  it("normalizes CamelCase name", () => {
    expect(normalizeForFilter("RefactorAuth")).toBe("refactorauth");
  });

  it("normalizes name with underscores", () => {
    expect(normalizeForFilter("add_new_feature")).toBe("add-new-feature");
  });

  it("normalizes empty string", () => {
    expect(normalizeForFilter("")).toBe("");
  });

  it("name substring matching works after normalization", () => {
    const name = normalizeForFilter("Update API endpoints v2");
    const filter = normalizeForFilter("api endpoints");
    expect(name.includes(filter)).toBe(true);
  });

  it("name with path separators normalizes same as directory", () => {
    // A name like "C:/foo/bar" normalizes to same pattern as a directory
    const nameNorm = normalizeForFilter("project/subdir");
    const dirNorm = normalizeForFilter("project\\subdir");
    expect(nameNorm).toBe(dirNorm);
  });
});

// ── Snippet map from content search results ─────────────────────────
// Mirrors ResumePicker lines ~288-294: useMemo building Map<string, string>

function buildSnippetMap(results: ContentSearchMatch[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of results) {
    map.set(r.sessionId, r.snippet);
  }
  return map;
}

describe("ResumePicker snippetMap: content search results", () => {
  it("builds map from results array", () => {
    const results: ContentSearchMatch[] = [
      { sessionId: "s1", snippet: "...matched text..." },
      { sessionId: "s2", snippet: "...other match..." },
    ];
    const map = buildSnippetMap(results);
    expect(map.size).toBe(2);
    expect(map.get("s1")).toBe("...matched text...");
    expect(map.get("s2")).toBe("...other match...");
  });

  it("returns empty map for empty results", () => {
    const map = buildSnippetMap([]);
    expect(map.size).toBe(0);
  });

  it("last result wins when duplicate sessionIds exist", () => {
    const results: ContentSearchMatch[] = [
      { sessionId: "s1", snippet: "first" },
      { sessionId: "s1", snippet: "second" },
    ];
    const map = buildSnippetMap(results);
    expect(map.size).toBe(1);
    expect(map.get("s1")).toBe("second");
  });

  it("handles single result", () => {
    const results: ContentSearchMatch[] = [
      { sessionId: "solo", snippet: "only match" },
    ];
    const map = buildSnippetMap(results);
    expect(map.get("solo")).toBe("only match");
  });
});

// ── Content search merge logic ──────────────────────────────────────
// Mirrors ResumePicker lines ~297-334: computing displayList + contentDividerIndex

interface MergedChain {
  resumeSession: PastSession;
  members: PastSession[];
  displayName: string | null;
  latestDate: string;
  totalSize: number;
  firstMessage: string;
  lastMessage: string;
  model: string;
  chainLength: number;
  dirExists: boolean;
}

function mkChain(ps: PastSession, members?: PastSession[]): MergedChain {
  return {
    resumeSession: ps,
    members: members || [ps],
    displayName: null,
    latestDate: ps.lastModified,
    totalSize: ps.sizeBytes,
    firstMessage: ps.firstMessage,
    lastMessage: ps.lastMessage,
    model: ps.model,
    chainLength: members ? members.length : 1,
    dirExists: ps.dirExists,
  };
}

function computeDisplayList(
  mergedList: MergedChain[],
  contentResults: ContentSearchMatch[],
  pastSessions: PastSession[],
  sessionNames: Record<string, string>,
): { displayList: MergedChain[]; contentDividerIndex: number } {
  const metadataIds = new Set<string>();
  for (const chain of mergedList) {
    for (const m of chain.members) {
      metadataIds.add(m.id);
    }
  }

  const pastSessionMap = new Map<string, PastSession>();
  for (const ps of pastSessions) {
    pastSessionMap.set(ps.id, ps);
  }

  const additionalChains: MergedChain[] = [];
  for (const r of contentResults) {
    if (metadataIds.has(r.sessionId)) continue;
    const ps = pastSessionMap.get(r.sessionId);
    if (!ps) continue;

    additionalChains.push({
      resumeSession: ps,
      members: [ps],
      displayName: sessionNames[ps.id] || null,
      latestDate: ps.lastModified,
      totalSize: ps.sizeBytes,
      firstMessage: ps.firstMessage,
      lastMessage: ps.lastMessage,
      model: ps.model,
      chainLength: 1,
      dirExists: ps.dirExists,
    });
  }

  return {
    displayList: [...mergedList, ...additionalChains],
    contentDividerIndex: additionalChains.length > 0 ? mergedList.length : -1,
  };
}

describe("ResumePicker content search merge", () => {
  const s1 = mkPastSession({ id: "s1", directory: "C:/proj1" });
  const s2 = mkPastSession({ id: "s2", directory: "C:/proj2" });
  const s3 = mkPastSession({ id: "s3", directory: "C:/proj3" });
  const s4 = mkPastSession({ id: "s4", directory: "C:/proj4" });

  it("appends content-only results after metadata results", () => {
    const mergedList = [mkChain(s1)];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s2", snippet: "found in s2" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1, s2], {});
    expect(result.displayList).toHaveLength(2);
    expect(result.displayList[0].resumeSession.id).toBe("s1");
    expect(result.displayList[1].resumeSession.id).toBe("s2");
  });

  it("sets contentDividerIndex to mergedList length when there are additional chains", () => {
    const mergedList = [mkChain(s1), mkChain(s2)];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s3", snippet: "found" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1, s2, s3], {});
    expect(result.contentDividerIndex).toBe(2);
  });

  it("sets contentDividerIndex to -1 when no additional chains", () => {
    const mergedList = [mkChain(s1)];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s1", snippet: "already in metadata" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1], {});
    expect(result.contentDividerIndex).toBe(-1);
    expect(result.displayList).toHaveLength(1);
  });

  it("deduplicates: content results for sessions already in metadata are skipped", () => {
    const chain = mkChain(s1, [s1, s2]); // chain containing s1 and s2
    const mergedList = [chain];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s1", snippet: "duplicate" },
      { sessionId: "s2", snippet: "also duplicate" },
      { sessionId: "s3", snippet: "new match" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1, s2, s3], {});
    expect(result.displayList).toHaveLength(2);
    expect(result.displayList[1].resumeSession.id).toBe("s3");
  });

  it("skips content results whose sessionId is not in pastSessions", () => {
    const mergedList: MergedChain[] = [];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "nonexistent", snippet: "orphan match" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1], {});
    expect(result.displayList).toHaveLength(0);
    expect(result.contentDividerIndex).toBe(-1);
  });

  it("resolves displayName from sessionNames for content-only results", () => {
    const mergedList: MergedChain[] = [];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s1", snippet: "match" },
    ];
    const names = { s1: "My Named Session" };
    const result = computeDisplayList(mergedList, contentResults, [s1], names);
    expect(result.displayList[0].displayName).toBe("My Named Session");
  });

  it("sets displayName to null when session has no name", () => {
    const mergedList: MergedChain[] = [];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s1", snippet: "match" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1], {});
    expect(result.displayList[0].displayName).toBeNull();
  });

  it("handles empty content results with non-empty metadata", () => {
    const mergedList = [mkChain(s1)];
    const result = computeDisplayList(mergedList, [], [s1], {});
    expect(result.displayList).toHaveLength(1);
    expect(result.contentDividerIndex).toBe(-1);
  });

  it("handles both empty metadata and empty content results", () => {
    const result = computeDisplayList([], [], [], {});
    expect(result.displayList).toHaveLength(0);
    expect(result.contentDividerIndex).toBe(-1);
  });

  it("preserves metadata order, appends content-only in content result order", () => {
    const mergedList = [mkChain(s2), mkChain(s1)]; // s2 before s1
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s4", snippet: "fourth" },
      { sessionId: "s3", snippet: "third" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1, s2, s3, s4], {});
    expect(result.displayList.map((c) => c.resumeSession.id)).toEqual(["s2", "s1", "s4", "s3"]);
    expect(result.contentDividerIndex).toBe(2);
  });

  it("content-only chains always have chainLength 1", () => {
    const mergedList: MergedChain[] = [];
    const contentResults: ContentSearchMatch[] = [
      { sessionId: "s1", snippet: "match" },
    ];
    const result = computeDisplayList(mergedList, contentResults, [s1], {});
    expect(result.displayList[0].chainLength).toBe(1);
    expect(result.displayList[0].members).toHaveLength(1);
  });
});
