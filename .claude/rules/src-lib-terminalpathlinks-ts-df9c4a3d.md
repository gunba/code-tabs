---
paths:
  - "src/lib/terminalPathLinks.ts"
---

# src/lib/terminalPathLinks.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Terminal Path Links

- [TP-01 L54] createPathLinkProvider (src/lib/terminalPathLinks.ts) implements xterm.js ILinkProvider that detects file-path tokens on each terminal line using PATH_RE regex (absolute, ~, ./, ../, drive-letter, and bare multi-segment paths). For each candidate line the provider: (1) extracts and trims trailing punctuation; (2) resolves relative paths against the session cwd (obtained via getCwd() closure, lazily resolved via Tauri homeDir() for ~ expansion); (3) batches unresolved paths into a single 'paths_exist' Tauri command call; (4) returns ILink entries with underline+pointer decorations only for existing paths. Click handler: plain click -> Tauri 'shell_open', Ctrl/Cmd+click -> 'reveal_in_file_manager'. Per-cwd LRU cache (cap 500) cleared on cwd change; cache evicts oldest entry on overflow. :line[:col] suffixes stripped for existence check but preserved as link text.
