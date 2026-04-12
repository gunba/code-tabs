/**
 * Heuristic parser that extracts file operations from Bash command strings.
 *
 * Best-effort: we'd rather miss a file than produce a false positive.
 * Handles simple single-command invocations and redirections; bails on
 * complex constructs (loops, subshells, long pipe chains).
 */

import type { FileChangeKind } from "../types/activity";

export interface BashFileOp {
  path: string;
  kind: FileChangeKind;
}

/* ---------- command → kind mapping ---------- */

/** Commands whose first path argument is a read target. */
const READ_CMDS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "file", "stat",
  "md5sum", "sha256sum", "sha1sum", "xxd", "od", "hexdump",
  "sort", "uniq", "nl", "tac", "rev", "fold", "cut", "paste",
  "diff", "cmp", "comm",
  "source", ".", "type",
]);

/** Commands whose path arguments are deleted. */
const DELETE_CMDS = new Set(["rm", "rmdir", "unlink"]);

/** Commands whose path arguments are created. */
const CREATE_CMDS = new Set(["touch", "mkdir"]);

/** Two-operand commands: first arg is read, last arg is created. */
const COPY_CMDS = new Set(["cp", "install"]);

/** Two-operand commands: first arg is deleted (source), last arg is created. */
const MOVE_CMDS = new Set(["mv"]);

/** Commands whose path arguments are modified (permission/ownership). */
const MODIFY_CMDS = new Set(["chmod", "chown", "chgrp", "truncate"]);

/* ---------- bail-out heuristics ---------- */

const TOO_COMPLEX = /[`$]|\bfor\b|\bwhile\b|\bif\b|\bdo\b|\bdone\b|\bthen\b|\bfi\b|\bcase\b|\besac\b|\bfunction\b/;
const GLOB_CHARS = /[*?[\]{}]/;
const MAX_OPS = 5;

/* ---------- redirect extraction ---------- */

/** Match output redirections: > file, >> file, 2> file, &> file, 2>> file */
const REDIRECT_RE = /(?:&>>?|[12]?>>?)\s*(\S+)/g;

/** Match input redirection: < file */
const INPUT_REDIRECT_RE = /<\s*(\S+)/g;

/* ---------- tokenizer ---------- */

/**
 * Minimal shell tokenizer — splits on whitespace, respecting single and double
 * quotes, but does NOT handle escape sequences or variable expansion (we bail
 * on those via TOO_COMPLEX anyway).
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of cmd) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && (ch === " " || ch === "\t")) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

// [BA-01] maskQuoted: replace quoted-string content with spaces so '>' in patterns isn't treated as redirect
// [BA-02] Position-based splice: redirect tokens removed by index from masked view before tokenizing
/**
 * Replace characters inside single/double-quoted substrings with spaces so
 * regex-based redirect extraction does not mistake content like `fn foo() ->
 * &str>` inside a grep/rg pattern for a real `>` redirect operator. Preserves
 * string length so match indices map 1:1 to positions in the original command.
 */
function maskQuoted(cmd: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of cmd) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      result += " ";
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      result += " ";
      continue;
    }
    if (inSingle || inDouble) {
      result += " ";
    } else {
      result += ch;
    }
  }
  return result;
}

/* ---------- path validation ---------- */

function isPlausiblePath(token: string): boolean {
  if (token.startsWith("-")) return false;           // flag
  if (token.includes("=")) return false;             // env assignment
  if (GLOB_CHARS.test(token)) return false;          // glob
  if (/['"]/.test(token)) return false;              // quote residue from imprecise regex extraction
  if (token.startsWith("http://") || token.startsWith("https://")) return false;
  if (token === "." || token === "..") return false;
  // Must contain a slash or a dot (to look like a filename)
  if (!token.includes("/") && !token.includes("\\") && !token.includes(".")) return false;
  return true;
}

function resolvePath(token: string, workingDir: string): string {
  // Already absolute
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("/")) return token;
  // Relative — join with working dir
  const sep = workingDir.includes("\\") ? "\\" : "/";
  const base = workingDir.replace(/[\\/]+$/, "");
  return `${base}${sep}${token}`;
}

/* ---------- main parser ---------- */

/**
 * Parse a bash command string and return heuristic file operations.
 * Returns empty array if the command is too complex or no files are detected.
 */
export function parseBashFileOps(command: string, workingDir: string): BashFileOp[] {
  const trimmed = command.trim();
  if (!trimmed) return [];

  // Bail on complex constructs — too easy to get wrong
  if (TOO_COMPLEX.test(trimmed)) return [];

  const ops: BashFileOp[] = [];
  const seen = new Set<string>();

  const push = (rawPath: string, kind: FileChangeKind) => {
    if (ops.length >= MAX_OPS) return;
    const resolved = resolvePath(rawPath, workingDir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    ops.push({ path: resolved, kind });
  };

  // 1. Extract redirect targets before tokenizing (they apply regardless of command)
  //    Run regexes on a quote-masked view so `>` inside quoted strings (e.g. a
  //    Rust type signature in a grep pattern) isn't mistaken for a redirect.
  //    Masking preserves positions, so match.index is valid against `trimmed`.
  const masked = maskQuoted(trimmed);
  let redirectCleaned = trimmed;

  for (const m of masked.matchAll(REDIRECT_RE)) {
    const target = m[1];
    if (isPlausiblePath(target)) {
      push(target, "modified");
    }
    // Remove the redirect from the command so it doesn't confuse the tokenizer
    redirectCleaned =
      redirectCleaned.slice(0, m.index) +
      " ".repeat(m[0].length) +
      redirectCleaned.slice(m.index + m[0].length);
  }

  for (const m of masked.matchAll(INPUT_REDIRECT_RE)) {
    const target = m[1];
    if (isPlausiblePath(target)) {
      push(target, "read");
    }
    redirectCleaned =
      redirectCleaned.slice(0, m.index) +
      " ".repeat(m[0].length) +
      redirectCleaned.slice(m.index + m[0].length);
  }

  // 2. Split on pipes and semicolons — process each segment independently
  //    But limit to 3 segments to avoid pipe-chain noise
  const segments = redirectCleaned.split(/\s*[|;]\s*/);
  if (segments.length > 3) return ops; // keep redirects but skip command parsing

  for (const segment of segments) {
    const tokens = tokenize(segment.trim());
    if (tokens.length === 0) continue;

    // Strip leading env assignments (VAR=val) and command prefixes (sudo, env, etc.)
    let cmdIdx = 0;
    while (cmdIdx < tokens.length) {
      if (tokens[cmdIdx].includes("=") && !tokens[cmdIdx].startsWith("-")) {
        cmdIdx++;
        continue;
      }
      if (tokens[cmdIdx] === "sudo" || tokens[cmdIdx] === "env" || tokens[cmdIdx] === "command") {
        cmdIdx++;
        continue;
      }
      break;
    }
    if (cmdIdx >= tokens.length) continue;

    const cmd = tokens[cmdIdx];
    // Strip path prefix: /usr/bin/cat → cat
    const baseName = cmd.includes("/") ? cmd.split("/").pop()! : cmd;

    const args = tokens.slice(cmdIdx + 1).filter((t) => !t.startsWith("-"));

    if (READ_CMDS.has(baseName)) {
      for (const arg of args) {
        if (isPlausiblePath(arg)) push(arg, "read");
      }
    } else if (DELETE_CMDS.has(baseName)) {
      for (const arg of args) {
        if (isPlausiblePath(arg)) push(arg, "deleted");
      }
    } else if (CREATE_CMDS.has(baseName)) {
      for (const arg of args) {
        if (isPlausiblePath(arg)) push(arg, "created");
      }
    } else if (MODIFY_CMDS.has(baseName)) {
      for (const arg of args) {
        if (isPlausiblePath(arg)) push(arg, "modified");
      }
    } else if (COPY_CMDS.has(baseName) && args.length >= 2) {
      // Last arg is destination
      const pathArgs = args.filter((a) => isPlausiblePath(a));
      if (pathArgs.length >= 2) {
        for (let i = 0; i < pathArgs.length - 1; i++) push(pathArgs[i], "read");
        push(pathArgs[pathArgs.length - 1], "created");
      }
    } else if (MOVE_CMDS.has(baseName) && args.length >= 2) {
      const pathArgs = args.filter((a) => isPlausiblePath(a));
      if (pathArgs.length >= 2) {
        for (let i = 0; i < pathArgs.length - 1; i++) push(pathArgs[i], "deleted");
        push(pathArgs[pathArgs.length - 1], "created");
      }
    } else if (baseName === "tee") {
      // tee writes to files AND stdout
      for (const arg of args) {
        if (isPlausiblePath(arg)) push(arg, "modified");
      }
    }
  }

  return ops;
}
