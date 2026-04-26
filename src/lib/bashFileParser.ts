import { parse } from "shell-quote";
import type { ParseEntry } from "shell-quote";
import { canonicalizePath } from "./paths";

export type BashFileOpKind = "created" | "modified" | "deleted" | "read" | "searched";

export interface BashFileOp {
  path: string;
  kind: BashFileOpKind;
  isFolder?: boolean;
}

type StringEntry = string;
type OpEntry = Extract<ParseEntry, { op: unknown }>;

function isString(entry: ParseEntry): entry is StringEntry {
  return typeof entry === "string";
}

function isOp(entry: ParseEntry): entry is OpEntry {
  return typeof entry === "object" && entry !== null && "op" in entry;
}

const STATEMENT_SEPARATORS = new Set(["&&", "||", ";", "|", "&", "|&", ";;", "(", ")"]);

function looksLikePath(s: string): boolean {
  if (!s) return false;
  if (s.startsWith("-")) return false;
  if (s.includes("\u0000")) return false;
  if (s === "*" || s === "**") return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) return false;
  return true;
}

function looksLikeFilePath(path: string): boolean {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  if (!base || base === "." || base === "..") return false;
  return base.includes(".");
}

function isFolderLike(path: string): boolean {
  if (path === "." || path === "..") return true;
  if (path.endsWith("/") || path.endsWith("\\")) return true;
  return !looksLikeFilePath(path);
}

function joinPath(cwd: string, p: string): string {
  if (!p) return p;
  const isAbsolute = p.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(p);
  if (isAbsolute) return canonicalizePath(p);
  if (!cwd) return canonicalizePath(p);
  const cleaned = p.replace(/^\.\//, "");
  if (cleaned === ".") return canonicalizePath(cwd);
  return canonicalizePath(`${cwd}/${cleaned}`);
}

function basename(cmd: string): string {
  const slash = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
  return slash >= 0 ? cmd.slice(slash + 1) : cmd;
}

interface OptionSpec {
  longWithValue?: Set<string>;
  shortWithValue?: Set<string>;
}

function stripOptions(args: string[], spec: OptionSpec = {}): string[] {
  const out: string[] = [];
  const longWithValue = spec.longWithValue ?? new Set<string>();
  const shortWithValue = spec.shortWithValue ?? new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (eq < 0 && longWithValue.has(name)) i++;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const letters = arg.slice(1);
      const needsSeparateValue = [...letters].some((ch) => shortWithValue.has(ch))
        && letters.length === 1;
      if (needsSeparateValue) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function pushReadOps(args: string[], cwd: string, ops: BashFileOp[]): void {
  for (const arg of args) {
    if (looksLikePath(arg)) ops.push({ path: joinPath(cwd, arg), kind: "read" });
  }
}

function pushSearchOps(args: string[], cwd: string, ops: BashFileOp[]): void {
  const targets = args.filter(looksLikePath);
  const paths = targets.length > 0 ? targets : (cwd ? [cwd] : []);
  for (const path of paths) {
    ops.push({
      path: joinPath(cwd, path),
      kind: "searched",
      isFolder: isFolderLike(path),
    });
  }
}

function findSearchRoots(args: string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")") break;
    if (looksLikePath(arg)) roots.push(arg);
  }
  return roots;
}

function parseStatement(tokens: ParseEntry[], cwd: string, ops: BashFileOp[]): void {
  if (tokens.length === 0) return;

  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j];
    if (isOp(t) && (t.op === ">" || t.op === ">>" || t.op === "<")) {
      const next = tokens[j + 1];
      if (next && isString(next) && looksLikePath(next)) {
        ops.push({
          path: joinPath(cwd, next),
          kind: t.op === "<" ? "read" : t.op === ">>" ? "modified" : "created",
        });
      }
    }
  }

  let i = 0;
  while (i < tokens.length && isString(tokens[i]) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] as string)) {
    i++;
  }
  if (i >= tokens.length || !isString(tokens[i])) return;

  let cmdToken = tokens[i] as string;
  if (cmdToken === "sudo" || cmdToken === "doas") {
    i++;
    while (i < tokens.length && isString(tokens[i]) && (tokens[i] as string).startsWith("-")) {
      i++;
    }
    if (i >= tokens.length || !isString(tokens[i])) return;
    cmdToken = tokens[i] as string;
  }
  const cmd = basename(cmdToken);

  const rest: string[] = [];
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (isString(t)) {
      rest.push(t);
    } else if (isOp(t) && (t.op === ">" || t.op === ">>" || t.op === "<")) {
      j++;
    } else {
      break;
    }
  }
  const positional = rest.filter((a) => !a.startsWith("-"));
  const readOptionSpec: OptionSpec = {
    longWithValue: new Set(["--bytes", "--chars", "--lines", "--format"]),
    shortWithValue: new Set(["c", "n"]),
  };
  const searchOptionSpec: OptionSpec = {
    longWithValue: new Set([
      "--after-context", "--before-context", "--context", "--context-separator",
      "--encoding", "--engine", "--field-match-separator", "--field-context-separator",
      "--glob", "--iglob", "--json-seq", "--max-columns", "--max-count",
      "--max-depth", "--max-filesize", "--mmap", "--path-separator", "--pre",
      "--pre-glob", "--regex-size-limit", "--regexp", "--replace", "--sort", "--sort-files",
      "--type", "--type-add", "--type-clear", "--type-not",
      "--file",
    ]),
    shortWithValue: new Set(["A", "B", "C", "e", "f", "g", "m", "t", "T"]),
  };

  switch (cmd) {
    case "rm": {
      for (const arg of positional) {
        if (looksLikePath(arg)) ops.push({ path: joinPath(cwd, arg), kind: "deleted" });
      }
      break;
    }
    case "rmdir": {
      for (const arg of positional) {
        if (looksLikePath(arg)) ops.push({ path: joinPath(cwd, arg), kind: "deleted", isFolder: true });
      }
      break;
    }
    case "mv": {
      if (positional.length >= 2) {
        const dst = positional[positional.length - 1];
        for (const src of positional.slice(0, -1)) {
          if (looksLikePath(src)) ops.push({ path: joinPath(cwd, src), kind: "deleted" });
        }
        if (looksLikePath(dst)) ops.push({ path: joinPath(cwd, dst), kind: "created" });
      }
      break;
    }
    case "cp": {
      if (positional.length >= 2) {
        const dst = positional[positional.length - 1];
        if (looksLikePath(dst)) ops.push({ path: joinPath(cwd, dst), kind: "created" });
      }
      break;
    }
    case "touch": {
      for (const arg of positional) {
        if (looksLikePath(arg)) ops.push({ path: joinPath(cwd, arg), kind: "created" });
      }
      break;
    }
    case "mkdir": {
      for (const arg of positional) {
        if (looksLikePath(arg)) ops.push({ path: joinPath(cwd, arg), kind: "created", isFolder: true });
      }
      break;
    }
    case "tee": {
      const append = rest.some((a) => a === "-a" || a === "--append");
      for (const arg of positional) {
        if (looksLikePath(arg)) ops.push({ path: joinPath(cwd, arg), kind: append ? "modified" : "created" });
      }
      break;
    }
    case "ln": {
      if (positional.length >= 2) {
        const link = positional[positional.length - 1];
        if (looksLikePath(link)) ops.push({ path: joinPath(cwd, link), kind: "created" });
      }
      break;
    }
    case "cat":
    case "bat":
    case "less":
    case "more":
    case "nl":
    case "wc":
    case "file":
    case "stat":
    case "readlink":
    case "realpath":
    case "head":
    case "tail": {
      pushReadOps(stripOptions(rest, readOptionSpec), cwd, ops);
      break;
    }
    case "sed": {
      const args = stripOptions(rest, {
        longWithValue: new Set(["--expression", "--file"]),
        shortWithValue: new Set(["e", "f"]),
      });
      pushReadOps(args.length > 1 ? args.slice(1) : [], cwd, ops);
      break;
    }
    case "awk": {
      const args = stripOptions(rest, {
        longWithValue: new Set(["--file", "--assign"]),
        shortWithValue: new Set(["f", "v"]),
      });
      pushReadOps(args.length > 1 ? args.slice(1) : [], cwd, ops);
      break;
    }
    case "rg":
    case "grep": {
      const hasFilesMode = rest.some((a) => a === "--files" || a === "--files-with-matches" || a === "-l");
      const patternFromOption = rest.some((a) =>
        a === "-e" || a === "-f" || a.startsWith("-e") || a.startsWith("-f")
        || a === "--regexp" || a.startsWith("--regexp=")
        || a === "--file" || a.startsWith("--file=")
      );
      const args = stripOptions(rest, searchOptionSpec);
      pushSearchOps(hasFilesMode || patternFromOption ? args : args.slice(1), cwd, ops);
      break;
    }
    case "fd": {
      const args = stripOptions(rest, {
        longWithValue: new Set(["--base-directory", "--changed-before", "--changed-within", "--color", "--exclude", "--extension", "--glob", "--max-depth", "--min-depth", "--search-path", "--threads", "--type"]),
        shortWithValue: new Set(["E", "e", "j", "t"]),
      });
      pushSearchOps(args.slice(1), cwd, ops);
      break;
    }
    case "find": {
      pushSearchOps(findSearchRoots(rest), cwd, ops);
      break;
    }
    case "ls":
    case "tree": {
      pushSearchOps(stripOptions(rest, readOptionSpec), cwd, ops);
      break;
    }
    default:
      break;
  }
}

// [DF-12] Parse Bash command strings into file activity ops (mutations plus common read/search commands)
export function parseBashFiles(command: string, cwd: string): BashFileOp[] {
  if (!command) return [];
  let tokens: ParseEntry[];
  try {
    tokens = parse(command);
  } catch {
    return [];
  }

  const ops: BashFileOp[] = [];
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    const isLast = i === tokens.length;
    const t = isLast ? null : tokens[i];
    const isSeparator = !isLast && t !== null && isOp(t) && STATEMENT_SEPARATORS.has((t as OpEntry).op);
    if (isLast || isSeparator) {
      parseStatement(tokens.slice(start, i), cwd, ops);
      start = i + 1;
    }
  }
  return ops;
}
