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
const PATH_RE =
  /(?<![\w\/\\:.])(?:(?:[A-Za-z]:|~|\.{1,2})?[\/\\](?:[\w.\-]+[\/\\])*[\w.\-]+|[\w.\-]+(?:[\/\\][\w.\-]+)+|[\w\-]+\.[\w\-]{1,10})(?::\d+(?::\d+)?)?/g;

// Trailing characters commonly stripped from path tokens found in prose.
const TRAILING_PUNCT_RE = /[).,;:"'>\]]+$/;

function trimTrailingPunct(raw: string): string {
  // Preserve `:line[:col]` suffix: only trim non-digit trailing punct.
  if (/:\d+(?::\d+)?$/.test(raw)) return raw;
  return raw.replace(TRAILING_PUNCT_RE, "");
}

interface CreateOptions {
  term: Terminal;
  getCwd: () => string | null;
}

// Small LRU; cleared externally when cwd changes.
const RESOLUTION_CACHE_CAP = 500;

// [TP-01] xterm.js ILinkProvider: emits path tokens to the `resolve_paths`
// Tauri command (literal + TTL-cached subtree lookup) and produces a
// clickable link for any candidate the backend resolves to an existing
// file. Click=shell_open, Ctrl/Cmd=reveal_in_file_manager.
export function createPathLinkProvider({ term, getCwd }: CreateOptions): {
  provider: ILinkProvider;
  clearCache: () => void;
} {
  // candidate string (post-trim) -> resolved absolute path (null = no match)
  const resolutionCache = new Map<string, string | null>();
  let cachedCwd: string | null = null;

  const cacheSet = (candidate: string, abs: string | null) => {
    resolutionCache.delete(candidate);
    resolutionCache.set(candidate, abs);
    if (resolutionCache.size > RESOLUTION_CACHE_CAP) {
      const oldest = resolutionCache.keys().next().value;
      if (oldest !== undefined) resolutionCache.delete(oldest);
    }
  };

  const clearCache = () => {
    resolutionCache.clear();
  };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const cwd = getCwd();
      if (cachedCwd !== cwd) {
        cachedCwd = cwd;
        resolutionCache.clear();
      }

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

      type Candidate = {
        startCol: number; // 1-based
        endCol: number; // 1-based inclusive
        raw: string; // cleaned candidate string (sent to backend, cache key)
      };
      const candidates: Candidate[] = [];

      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(text)) !== null) {
        if (m[0].length === 0) {
          PATH_RE.lastIndex++;
          continue;
        }
        const cleaned = trimTrailingPunct(m[0]);
        if (!cleaned || cleaned.includes("://")) continue;
        candidates.push({
          startCol: m.index + 1,
          endCol: m.index + cleaned.length,
          raw: cleaned,
        });
      }

      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      void (async () => {
        const unresolved: string[] = [];
        const seen = new Set<string>();
        for (const c of candidates) {
          if (!resolutionCache.has(c.raw) && !seen.has(c.raw)) {
            unresolved.push(c.raw);
            seen.add(c.raw);
          }
        }

        if (unresolved.length > 0) {
          try {
            const resolved = await invoke<ResolvedPath[]>("resolve_paths", {
              cwd,
              candidates: unresolved,
            });
            for (const r of resolved) cacheSet(r.candidate, r.absPath);
          } catch (err) {
            // Fail closed: cache nulls so we don't spin on a broken backend.
            for (const p of unresolved) cacheSet(p, null);
            dlog("terminal", null, `resolve_paths failed: ${err}`, "WARN", {
              event: "terminal.resolve_paths_failed",
              data: { error: String(err) },
            });
          }
        }

        const links: ILink[] = [];
        for (const c of candidates) {
          const abs = resolutionCache.get(c.raw) ?? null;
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

  return { provider, clearCache };
}
