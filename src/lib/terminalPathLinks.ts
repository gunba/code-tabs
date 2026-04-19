import type { ILinkProvider, ILink, Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { dlog } from "./debugLog";

interface PathStatus {
  path: string;
  exists: boolean;
  is_dir: boolean;
}

// Path-shaped tokens. Accepts:
//   /abs/path, ~/rel, ./rel, ../rel, C:\..., C:/..., foo/bar/baz
// Separator is / or \. Body chars: word + . -. Optional :line[:col] suffix.
// Lookbehind prevents matching in the middle of a larger token (e.g. URL tails).
const PATH_RE = /(?<![\w\/\\:])(?:(?:[A-Za-z]:|~|\.{1,2})?[\/\\](?:[\w.\-]+[\/\\])*[\w.\-]+|[\w.\-]+(?:[\/\\][\w.\-]+)+)(?::\d+(?::\d+)?)?/g;

const LINE_SUFFIX_RE = /^(.+?)(:\d+(?::\d+)?)$/;

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\/\\]/.test(p);
}

function joinPath(cwd: string, rel: string): string {
  const sepIsWin = cwd.includes("\\") && !cwd.includes("/");
  const sep = sepIsWin ? "\\" : "/";
  const trimmed = cwd.replace(/[\/\\]+$/, "");
  return `${trimmed}${sep}${rel}`;
}

function splitSuffix(raw: string): { path: string; suffix: string } {
  const m = raw.match(LINE_SUFFIX_RE);
  return m ? { path: m[1], suffix: m[2] } : { path: raw, suffix: "" };
}

// Trailing characters regex commonly strips things like `).,;:"'` that tend to follow paths in prose.
// We do NOT strip if the char is part of a :line:col suffix; the regex already handles that.
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
const EXISTENCE_CACHE_CAP = 500;

// [TP-01] xterm.js ILinkProvider: detects file paths on terminal lines, validates existence via paths_exist, click=shell_open Ctrl/Cmd=reveal_in_file_manager
export function createPathLinkProvider({ term, getCwd }: CreateOptions): {
  provider: ILinkProvider;
  clearCache: () => void;
} {
  const existenceCache = new Map<string, boolean>();
  let cachedCwd: string | null = null;
  let cachedHome: string | null = null;
  let homeLoaded = false;

  // Resolve home lazily once; subsequent calls use the cached value.
  const ensureHome = async () => {
    if (homeLoaded) return;
    homeLoaded = true;
    try {
      cachedHome = await homeDir();
      // Trim trailing separator for consistent joining.
      cachedHome = cachedHome.replace(/[\/\\]+$/, "");
    } catch {
      cachedHome = null;
    }
  };

  const resolveAbsolute = (rawPath: string, cwd: string | null): string | null => {
    if (rawPath.startsWith("~")) {
      if (!cachedHome) return null;
      const rest = rawPath.slice(1).replace(/^[\/\\]/, "");
      return rest ? joinPath(cachedHome, rest) : cachedHome;
    }
    if (isAbsolute(rawPath)) return rawPath;
    if (!cwd) return null;
    return joinPath(cwd, rawPath);
  };

  const cacheSet = (path: string, exists: boolean) => {
    existenceCache.delete(path);
    existenceCache.set(path, exists);
    if (existenceCache.size > EXISTENCE_CACHE_CAP) {
      const oldest = existenceCache.keys().next().value;
      if (oldest !== undefined) existenceCache.delete(oldest);
    }
  };

  const clearCache = () => {
    existenceCache.clear();
  };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const cwd = getCwd();
      if (cachedCwd !== cwd) {
        cachedCwd = cwd;
        existenceCache.clear();
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
        raw: string;
        absPath: string;
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
        // Require either a separator or a leading anchor (~, ., /, \, drive letter).
        const hasSep = /[\/\\]/.test(cleaned);
        const hasAnchor = /^([A-Za-z]:[\/\\]|~|\.{1,2}[\/\\]|[\/\\])/.test(cleaned);
        if (!hasSep && !hasAnchor) continue;

        const { path: noSuffix } = splitSuffix(cleaned);
        const abs = resolveAbsolute(noSuffix, cwd);
        if (!abs) continue;

        // Skip trivially: current xterm column indexing assumes ASCII-safe paths.
        candidates.push({
          startCol: m.index + 1,
          endCol: m.index + cleaned.length,
          raw: cleaned,
          absPath: abs,
        });
      }

      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      void (async () => {
        await ensureHome();

        const toCheck: string[] = [];
        for (const c of candidates) {
          if (!existenceCache.has(c.absPath)) toCheck.push(c.absPath);
        }

        if (toCheck.length > 0) {
          try {
            const statuses = await invoke<PathStatus[]>("paths_exist", { paths: toCheck });
            for (const s of statuses) cacheSet(s.path, s.exists);
          } catch (err) {
            // Fail open: treat as non-existent so we simply produce no link.
            for (const p of toCheck) cacheSet(p, false);
            dlog("terminal", null, `paths_exist failed: ${err}`, "WARN", {
              event: "terminal.paths_exist_failed",
              data: { error: String(err) },
            });
          }
        }

        const links: ILink[] = [];
        for (const c of candidates) {
          if (!existenceCache.get(c.absPath)) continue;
          links.push({
            range: {
              start: { x: c.startCol, y: bufferLineNumber },
              end: { x: c.endCol, y: bufferLineNumber },
            },
            text: c.raw,
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => {
              const reveal = event.ctrlKey || event.metaKey;
              invoke(reveal ? "reveal_in_file_manager" : "shell_open", { path: c.absPath }).catch(
                (e) => {
                  dlog("terminal", null, `path link open failed: ${e}`, "WARN", {
                    event: "terminal.path_link_open_failed",
                    data: { path: c.absPath, reveal, error: String(e) },
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
