---
paths:
  - "tools/proofd.py"
---

# tools/proofd.py

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Proofd pipeline

- [PP-02 L328,1943] proofd canonical rule storage strips manual file metadata; generated rule snapshots derive scope from source-tag locations only, and lint warns on rules with no source references.
- [PP-01 L1168,1214,1744,2023] proofd source-reference scans retain line numbers; generated file-scoped rules annotate tags with compact L<n> hints, order entries within each rule section by file line, and entry-files plus select-matching return line-aware source references for agents.
