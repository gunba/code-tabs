import { parse } from "shell-quote";
import type { ParseEntry } from "shell-quote";
import { canonicalizePath } from "./paths";

export type BashFileOpKind = "created" | "modified" | "deleted";

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
  return true;
}

function joinPath(cwd: string, p: string): string {
  if (!p) return p;
  const isAbsolute = p.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(p);
  if (isAbsolute) return canonicalizePath(p);
  if (!cwd) return canonicalizePath(p);
  const cleaned = p.replace(/^\.\//, "");
  return canonicalizePath(`${cwd}/${cleaned}`);
}

function basename(cmd: string): string {
  const slash = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
  return slash >= 0 ? cmd.slice(slash + 1) : cmd;
}

function parseStatement(tokens: ParseEntry[], cwd: string, ops: BashFileOp[]): void {
  if (tokens.length === 0) return;

  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j];
    if (isOp(t) && (t.op === ">" || t.op === ">>")) {
      const next = tokens[j + 1];
      if (next && isString(next) && looksLikePath(next)) {
        ops.push({
          path: joinPath(cwd, next),
          kind: t.op === ">>" ? "modified" : "created",
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
    default:
      break;
  }
}

// [DF-12] Parse Bash command strings into file-mutation ops (rm/mv/cp/touch/mkdir/tee/ln + redirections)
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
