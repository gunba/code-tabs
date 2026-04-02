// [TR-16] Cross-session text search (line-by-line, regex, capped results)
export interface SearchMatch {
  sessionId: string;
  lineIndex: number;    // 0-based buffer line
  lineText: string;     // full line text
  matchStart: number;   // char offset within line
  matchLength: number;
}

/**
 * Search across multiple session text buffers, returning matches up to `limit`.
 * Returns empty array for empty query or invalid regex (caller should check
 * `validateRegex` separately for user-facing error messages).
 */
export function searchBuffers(
  sessions: Array<{ id: string; text: string }>,
  query: string,
  caseSensitive: boolean,
  useRegex: boolean,
  limit: number,
): SearchMatch[] {
  if (!query) return [];

  let regex: RegExp;
  if (useRegex) {
    try {
      regex = new RegExp(query, caseSensitive ? "g" : "gi");
    } catch {
      return [];
    }
  } else {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, caseSensitive ? "g" : "gi");
  }

  const results: SearchMatch[] = [];

  for (const session of sessions) {
    const lines = session.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      const m = regex.exec(lines[i]);
      if (m) {
        results.push({
          sessionId: session.id,
          lineIndex: i,
          lineText: lines[i],
          matchStart: m.index,
          matchLength: m[0].length,
        });
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

/** Returns null if pattern is valid, or the error message string if invalid. */
export function validateRegex(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
