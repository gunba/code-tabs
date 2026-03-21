---
tools: Read, Glob, Grep
---

Find all TODO, FIXME, HACK, and XXX comments in the codebase.

1. Grep for TODO, FIXME, HACK, and XXX across all source files (.ts, .tsx, .rs).
2. Group results by file.
3. For each, include the surrounding context (2 lines before/after).
4. Output a prioritized summary: FIXMEs first, then TODOs, then the rest.
