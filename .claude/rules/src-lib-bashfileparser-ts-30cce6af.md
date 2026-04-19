---
paths:
  - "src/lib/bashFileParser.ts"
---

# src/lib/bashFileParser.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Data Flow

- [DF-12 L155] parseBashFiles (src/lib/bashFileParser.ts:L155) tokenizes a Bash command string with shell-quote and walks per-statement registries to extract file-mutation operations. Recognized commands: rm (deleted), rmdir (deleted, isFolder), mv (source=deleted, dest=created), cp (dest=created), touch (created), mkdir (created, isFolder), tee (created or modified with -a), ln (link=created), and > / >> redirections. Skips options (tokens starting with -), handles sudo/doas prefixes, and splits compound commands on &&, ||, ;, |. Paths resolved via canonicalizePath(joinPath(cwd, arg)). Results are heuristic: subshells, variable expansion, and globs are not handled. Called by useTapEventProcessor on ToolInput(Bash) events; path existence is validated by confirmEntries on settled-idle.
