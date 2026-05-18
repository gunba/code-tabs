import type { ILinkProvider, ILink, Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debugLog";

interface ResolvedPath {
  candidate: string;
  absPath: string | null;
  isDir: boolean;
}

// Path-shaped tokens. Three alternatives, in the order we match:
//   (a) anchored paths: /abs, ~/rel, ./rel, ../rel, C:\... , C:/...
//   (b) bare multi-segment paths: foo/bar/baz, src\components\foo.tsx
//   (c) bare filenames with extension: package.json, useTerminal.ts
// Optional :line[:col] suffix. Lookbehind rejects mid-token matches (URL
// tails, filename fragments inside other identifiers).
//
// Segments split into three flavours to balance space-tolerance against the
// risk of bridging two adjacent paths:
//
//   SEG_RICH (anchored INTERNAL segments only): allow multiple
//   space-separated words AND balanced (word) parens, so
//   "C:\Program Files (x86)\app.exe" and "~/My Cool Folder/file.tsx"
//   detect. Anchored paths can't easily collide with prose because the
//   anchor pins the start.
//
//   SEG_PLAIN (bare INTERNAL segments): one optional space-separated
//   word so "src/My Folder/file.tsx" detects, but bare prose like
//   "ratio 100/200/300 is" does not bridge — the strict leading/trailing
//   segments below guard the outer ends.
//
//   SEG_STRICT (all leading and trailing segments): strictly word chars
//   + dot/dash. The final segment of every alternative is SEG_STRICT so
//   trailing prose like "~/My Documents/config.json today" stops at
//   "config.json" — the regex never bleeds into the next word.
//
// The trailing lookahead excludes [\w.\\/-] but NOT ":" so "src/App.tsx:
// explanation" still extracts "src/App.tsx".
const SEG_RICH = "(?:[\\w.\\-]+|\\([\\w.\\-]+\\))(?:[ ](?:[\\w.\\-]+|\\([\\w.\\-]+\\)))*";
const SEG_PLAIN = "[\\w.\\-]+(?:[ ][\\w.\\-]+)?";
const SEG_STRICT = "[\\w.\\-]+";
const PATH_RE = new RegExp(
  "(?<![\\w/\\\\:.])(?:" +
    "(?:[A-Za-z]:|~|\\.{1,2})?[/\\\\](?:" + SEG_RICH + "[/\\\\])*" + SEG_STRICT +
    "|" +
    SEG_STRICT + "(?:[/\\\\]" + SEG_PLAIN + ")*[/\\\\]" + SEG_STRICT +
    "|" +
    "[\\w\\-]+\\.[\\w\\-]{1,10}" +
  ")(?::\\d+(?::\\d+)?)?(?![\\w./\\\\\\-])",
  "g",
);

// Wrapper characters commonly stripped from path tokens found in prose.
const LEADING_PUNCT_RE = /^[("'`<{\[]+/;
const TRAILING_PUNCT_RE = /[).,;:"'>\]]+$/;

function stripLineSuffix(candidate: string): string {
  return candidate.replace(/:\d+(?::\d+)?$/, "");
}

function trimPathPunct(raw: string): string {
  // Preserve `:line[:col]` suffix: only trim non-digit trailing punct.
  const trimmedLeading = raw.replace(LEADING_PUNCT_RE, "");
  if (/:\d+(?::\d+)?$/.test(trimmedLeading)) return trimmedLeading;
  // Keep trailing `)` when the path contains balanced parens internally
  // (e.g. "C:\Program Files (x86)\app.exe" — but apply only to a candidate
  // whose final ')' is part of a balanced pair, not stray prose punctuation).
  const opens = (trimmedLeading.match(/\(/g) || []).length;
  const closes = (trimmedLeading.match(/\)/g) || []).length;
  if (opens > 0 && opens === closes && trimmedLeading.endsWith(")")) {
    return trimmedLeading.replace(/[.,;:"'>\]]+$/, "");
  }
  return trimmedLeading.replace(TRAILING_PUNCT_RE, "");
}

function isPlausiblePathCandidate(candidate: string): boolean {
  const withoutLineSuffix = stripLineSuffix(candidate);
  if (withoutLineSuffix.includes("://")) return false;
  const segments = withoutLineSuffix.split(/[\/\\]/);
  if (segments.length > 1 && segments.every((segment) => /^\d+$/.test(segment))) {
    return false;
  }
  if (!/[\/\\]/.test(withoutLineSuffix)) {
    const parts = withoutLineSuffix.split(".");
    if (parts.length !== 2) return false;
    const [stem, ext] = parts;
    if (!stem || !ext) return false;
    if (/^\d+$/.test(stem)) return false;
    if (stem.length === 1 && ext.length === 1) return false;
  }
  return true;
}

export interface PathLinkCandidate {
  startCol: number; // 1-based
  endCol: number; // 1-based inclusive
  raw: string; // cleaned candidate string sent to backend
}

export function findPathLinkCandidates(text: string): PathLinkCandidate[] {
  const candidates: PathLinkCandidate[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      PATH_RE.lastIndex++;
      continue;
    }
    const cleaned = trimPathPunct(m[0]);
    if (!cleaned || m[0].includes("://") || !isPlausiblePathCandidate(cleaned)) continue;
    candidates.push({
      startCol: m.index + 1,
      endCol: m.index + cleaned.length,
      raw: cleaned,
    });
  }
  return candidates;
}

interface CreateOptions {
  term: Terminal;
  getCwd: () => string | null;
}

// [TP-01] xterm.js ILinkProvider: emits path tokens to the `resolve_paths`
// Tauri command (literal + TTL-cached subtree lookup) and produces a
// clickable link for any candidate the backend resolves to an existing
// file. Click=shell_open, Ctrl/Cmd=reveal_in_file_manager.
export function createPathLinkProvider({ term, getCwd }: CreateOptions): {
  provider: ILinkProvider;
} {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const cwd = getCwd();

      const buf = term.buffer.active;
      const line = buf.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text) {
        callback(undefined);
        return;
      }

      const candidates = findPathLinkCandidates(text);

      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      void (async () => {
        const uniqueCandidates: string[] = [];
        const seenCandidates = new Set<string>();
        for (const c of candidates) {
          if (!seenCandidates.has(c.raw)) {
            uniqueCandidates.push(c.raw);
            seenCandidates.add(c.raw);
          }
        }

        let resolved: ResolvedPath[];
        try {
          resolved = await invoke<ResolvedPath[]>("resolve_paths", {
            cwd,
            candidates: uniqueCandidates,
          });
        } catch (err) {
          dlog("terminal", null, `resolve_paths failed: ${err}`, "WARN", {
            event: "terminal.resolve_paths_failed",
            data: { error: String(err) },
          });
          callback(undefined);
          return;
        }

        const resolvedByCandidate = new Map(resolved.map((r) => [r.candidate, r]));
        const links: ILink[] = [];
        for (const c of candidates) {
          const abs = resolvedByCandidate.get(c.raw)?.absPath ?? null;
          if (!abs) continue;
          links.push({
            range: {
              start: { x: c.startCol, y: bufferLineNumber },
              end: { x: c.endCol, y: bufferLineNumber },
            },
            text: c.raw,
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => {
              const reveal = event.ctrlKey || event.metaKey;
              invoke(reveal ? "reveal_in_file_manager" : "shell_open", { path: abs }).catch(
                (e) => {
                  dlog("terminal", null, `path link open failed: ${e}`, "WARN", {
                    event: "terminal.path_link_open_failed",
                    data: { path: abs, reveal, error: String(e) },
                  });
                },
              );
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      })();
    },
  };

  return { provider };
}
