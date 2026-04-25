/** Returns null if pattern is valid, or the error message string if invalid. */
export function validateRegex(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export interface SnippetHighlight {
  before: string;
  matched: string;
  after: string;
}

interface HighlightArgs {
  snippet: string;
  matchOffset: number;
  matchLength: number;
  query: string;
  matchedText?: string | null;
  caseSensitive: boolean;
  useRegex: boolean;
}

interface SearchTargetArgs {
  snippet: string;
  matchOffset: number;
  matchLength: number;
  query: string;
  matchedText?: string | null;
  useRegex: boolean;
}

function sliceHighlight(snippet: string, start: number, end: number): SnippetHighlight {
  return {
    before: snippet.slice(0, start),
    matched: snippet.slice(start, end),
    after: snippet.slice(end),
  };
}

function findTextIndex(haystack: string, needle: string, caseSensitive: boolean): number {
  if (!needle) return -1;
  if (caseSensitive) return haystack.indexOf(needle);
  return haystack.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
}

function boundedRange(snippet: string, offset: number, length: number): [number, number] | null {
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) return null;
  const start = Math.max(0, Math.min(snippet.length, offset));
  const end = Math.max(start, Math.min(snippet.length, start + length));
  return end > start ? [start, end] : null;
}

/**
 * Build the visible match highlight for a result. Rust returns UTF-16 offsets
 * for current builds, but this still falls back to a local text lookup so older
 * byte-offset results do not render an unrelated highlighted slice.
 */
export function findSnippetHighlight({
  snippet,
  matchOffset,
  matchLength,
  query,
  matchedText,
  caseSensitive,
  useRegex,
}: HighlightArgs): SnippetHighlight {
  const range = boundedRange(snippet, matchOffset, matchLength);
  const offsetText = range ? snippet.slice(range[0], range[1]) : "";
  const expected = matchedText || (!useRegex ? query : "");

  if (range && offsetText) {
    if (!expected || findTextIndex(offsetText, expected, caseSensitive) >= 0) {
      return sliceHighlight(snippet, range[0], range[1]);
    }
  }

  if (expected) {
    const idx = findTextIndex(snippet, expected, caseSensitive);
    if (idx >= 0) return sliceHighlight(snippet, idx, idx + expected.length);
  }

  if (useRegex) {
    try {
      const re = new RegExp(query, caseSensitive ? "" : "i");
      const match = re.exec(snippet);
      if (match?.[0]) return sliceHighlight(snippet, match.index, match.index + match[0].length);
    } catch {
      // validateRegex handles the displayed error path; keep rendering resilient.
    }
  }

  if (range) return sliceHighlight(snippet, range[0], range[1]);
  return { before: snippet, matched: "", after: "" };
}

function cleanSnippetContext(text: string): string {
  return text
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUnique(out: string[], value: string): void {
  const cleaned = cleanSnippetContext(value);
  if (cleaned && !out.includes(cleaned)) out.push(cleaned);
}

/**
 * Candidate strings for locating a persisted search result in a live TUI.
 * Longer context is tried first to target the clicked message; shorter fallbacks
 * keep navigation useful when the TUI has reflowed or decorated the transcript.
 */
export function buildTerminalSearchTargets({
  snippet,
  matchOffset,
  matchLength,
  query,
  matchedText,
  useRegex,
}: SearchTargetArgs): string[] {
  const range = boundedRange(snippet, matchOffset, matchLength);
  const start = range?.[0] ?? Math.max(0, snippet.indexOf(matchedText || query));
  const end = range?.[1] ?? (start >= 0 ? start + (matchedText || query).length : -1);
  const out: string[] = [];

  if (start >= 0 && end > start) {
    const before = snippet.slice(Math.max(0, start - 80), start);
    const match = matchedText || snippet.slice(start, end);
    const after = snippet.slice(end, Math.min(snippet.length, end + 80));
    pushUnique(out, `${before}${match}${after}`);
    pushUnique(out, `${before.slice(-30)}${match}${after.slice(0, 30)}`);
    pushUnique(out, match);
  }

  if (!useRegex) pushUnique(out, query);
  return out;
}
