/**
 * TOML syntax highlighter for the Codex Settings pane overlay.
 *
 * Tokens & class names mirror the JSON highlighter (`SettingsPane.highlightJson`)
 * so existing CSS (`sh-key`, `sh-string`, `sh-number`, `sh-bool`, `sh-comment`)
 * carries over. Adds `sh-section` for `[name]` and `[[arrays]]` headers and
 * `sh-datetime` for RFC 3339 dates.
 *
 * Strategy: line-by-line tokenize. TOML's lexical structure is line-oriented
 * (statements end at \n unless inside a multi-line string). Multi-line basic
 * strings (`"""..."""`) and literal strings (`'''...'''`) are tracked across
 * lines via a state flag. Comments (`# …`) consume to end-of-line.
 *
 * This is a syntax overlay only — it doesn't validate TOML semantics. The
 * real parser (`smol-toml`, used elsewhere) handles correctness; we just
 * paint the textarea contents.
 */

export function highlightToml(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inMultiBasic = false; // inside """..."""
  let inMultiLiteral = false; // inside '''...'''

  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);

    if (inMultiBasic) {
      const closeIdx = line.indexOf("&quot;&quot;&quot;");
      if (closeIdx === -1) {
        out.push(`<span class="sh-string">${line}</span>`);
        continue;
      }
      const before = line.slice(0, closeIdx + "&quot;&quot;&quot;".length);
      const after = line.slice(closeIdx + "&quot;&quot;&quot;".length);
      inMultiBasic = false;
      out.push(`<span class="sh-string">${before}</span>${tokenizeLine(after)}`);
      continue;
    }
    if (inMultiLiteral) {
      const closeIdx = line.indexOf("&#39;&#39;&#39;");
      if (closeIdx === -1) {
        out.push(`<span class="sh-string">${line}</span>`);
        continue;
      }
      const before = line.slice(0, closeIdx + "&#39;&#39;&#39;".length);
      const after = line.slice(closeIdx + "&#39;&#39;&#39;".length);
      inMultiLiteral = false;
      out.push(`<span class="sh-string">${before}</span>${tokenizeLine(after)}`);
      continue;
    }

    // Look for the start of a multi-line string at the END of this line.
    // (If both the start and the close are on the same line, tokenizeLine
    // handles it as a single quoted string.)
    const tokenized = tokenizeLine(line);
    out.push(tokenized);

    // Update multi-line state by re-scanning the raw text (not the HTML)
    // for unmatched triple delimiters at end-of-line.
    const bareLine = rawLine;
    const tripleBasicCount = countTripleDelims(bareLine, '"""');
    const tripleLiteralCount = countTripleDelims(bareLine, "'''");
    if (tripleBasicCount % 2 === 1) inMultiBasic = !inMultiBasic;
    if (tripleLiteralCount % 2 === 1) inMultiLiteral = !inMultiLiteral;
  }

  return out.join("\n");
}

function tokenizeLine(line: string): string {
  // Whitespace-preserving tokenizer. Walks the line left-to-right, emitting
  // either an HTML-escaped raw chunk or a wrapped span for a recognized
  // token. Operates on the already-html-escaped input so the result is safe
  // to drop into innerHTML.
  let result = "";
  let i = 0;
  const n = line.length;

  // Detect leading whitespace then a `[` (section header) or `[[` (array
  // of tables). One section per line; everything up to the matching `]` /
  // `]]` is the header.
  const leadingWs = line.match(/^\s*/)?.[0] ?? "";
  if (
    leadingWs.length < n &&
    line[leadingWs.length] === "["
  ) {
    const isArray = line[leadingWs.length + 1] === "[";
    const closer = isArray ? "]]" : "]";
    const closeIdx = line.indexOf(closer, leadingWs.length + (isArray ? 2 : 1));
    if (closeIdx !== -1) {
      const headerEnd = closeIdx + closer.length;
      const header = line.slice(leadingWs.length, headerEnd);
      const trailing = line.slice(headerEnd);
      return `${leadingWs}<span class="sh-section">${header}</span>${tokenizeLine(trailing)}`;
    }
  }

  while (i < n) {
    const ch = line[i];

    // Comment: `#` to end-of-line.
    if (ch === "#") {
      result += `<span class="sh-comment">${line.slice(i)}</span>`;
      return result;
    }

    // Whitespace + non-token chars: pass through.
    if (ch === " " || ch === "\t" || ch === "=" || ch === "," || ch === "{" || ch === "}" || ch === "[" || ch === "]") {
      result += ch;
      i++;
      continue;
    }

    // String literals: `"..."`, `'...'`, `"""...same line..."""`, `'''...same line...'''`.
    if (ch === "&" && (line.startsWith("&quot;", i) || line.startsWith("&#39;", i))) {
      const isLiteral = line.startsWith("&#39;", i);
      const delimEntity = isLiteral ? "&#39;" : "&quot;";
      const delimLen = delimEntity.length;
      const isTriple =
        line.startsWith(delimEntity.repeat(3), i);
      if (isTriple) {
        const end = line.indexOf(delimEntity.repeat(3), i + delimLen * 3);
        if (end !== -1) {
          const fullLen = end - i + delimLen * 3;
          result += `<span class="sh-string">${line.slice(i, i + fullLen)}</span>`;
          i += fullLen;
          continue;
        }
        // Unterminated on this line — let multi-line state handle the rest.
        result += `<span class="sh-string">${line.slice(i)}</span>`;
        return result;
      }
      // Single-line string: walk to next unescaped delimiter.
      let j = i + delimLen;
      while (j < n) {
        if (!isLiteral && line.startsWith("\\", j)) {
          j += 2;
          continue;
        }
        if (line.startsWith(delimEntity, j)) {
          j += delimLen;
          break;
        }
        j++;
      }
      result += `<span class="sh-string">${line.slice(i, j)}</span>`;
      i = j;
      continue;
    }

    // Bare key followed by `=`: `^[A-Za-z0-9_-.]+\s*=`. Match greedy.
    const keyMatch = line.slice(i).match(/^[A-Za-z0-9_\-.]+(?=\s*=)/);
    if (keyMatch) {
      result += `<span class="sh-key">${keyMatch[0]}</span>`;
      i += keyMatch[0].length;
      continue;
    }

    // RFC 3339 datetime: rough match. We only color it; parsing accuracy
    // doesn't matter for highlighting.
    const dtMatch = line
      .slice(i)
      .match(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/);
    if (dtMatch) {
      result += `<span class="sh-datetime">${dtMatch[0]}</span>`;
      i += dtMatch[0].length;
      continue;
    }

    // Numbers: integers (with optional underscores), floats, hex/oct/bin
    // prefixes. Conservative match — we don't reject malformed numbers.
    const numMatch = line.slice(i).match(/^[+-]?(?:0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9_]+(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)/);
    if (numMatch && (i === 0 || !/[A-Za-z]/.test(line[i - 1]))) {
      result += `<span class="sh-number">${numMatch[0]}</span>`;
      i += numMatch[0].length;
      continue;
    }

    // Booleans: `true` / `false`.
    if (line.startsWith("true", i) && !isIdentChar(line, i + 4)) {
      result += `<span class="sh-bool">true</span>`;
      i += 4;
      continue;
    }
    if (line.startsWith("false", i) && !isIdentChar(line, i + 5)) {
      result += `<span class="sh-bool">false</span>`;
      i += 5;
      continue;
    }

    // Anything else: pass through as one char.
    result += ch;
    i++;
  }

  return result;
}

function isIdentChar(s: string, i: number): boolean {
  if (i >= s.length) return false;
  const c = s[i];
  return /[A-Za-z0-9_\-.]/.test(c);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function countTripleDelims(line: string, delim: string): number {
  let count = 0;
  let i = 0;
  while ((i = line.indexOf(delim, i)) !== -1) {
    count++;
    i += delim.length;
  }
  return count;
}
