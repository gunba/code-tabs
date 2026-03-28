---
paths:
  - "src/components/DiffPanel/**"
  - "src/lib/diffParser.ts"
---

# Git Diff Panel

<!-- Codes: GD=Git Diff Panel -->

- [GD-01] Side panel (400px, 280px min, 55% max) toggled via Ctrl+Shift+G. Shows staged, unstaged, and untracked files in collapsible sections with per-file insertion/deletion stats. Header shows branch name, total insertions/deletions with pulse animation on change, and file count.
  - Files: src/components/DiffPanel/DiffPanel.tsx, src/components/DiffPanel/DiffPanel.css
- [GD-02] Clicking a file opens a side-by-side diff modal (96vw/88vh, via ModalOverlay + createPortal). Left pane shows old content (deletions highlighted red), right pane shows new content (additions highlighted green). Context lines appear on both sides. Single scroll container (4-cell table rows) eliminates scroll sync complexity.
  - Files: src/components/DiffPanel/DiffModal.tsx
- [GD-03] Syntax highlighting in diff modal via highlight.js/lib/core with 23 registered languages (typescript, javascript, rust, python, go, java, c, cpp, csharp, ruby, swift, kotlin, xml, css, scss, json, yaml, ini, markdown, sql, bash, powershell, dockerfile). Language detected from file extension. Token colors use CSS custom properties for theme consistency. HTML escaped before highlighting (XSS safety).
  - Files: src/components/DiffPanel/DiffModal.tsx
- [GD-04] Modal file navigation: prev/next arrows in header cycle through all changed files (staged -> unstaged -> untracked, wrapping). Alt+Left/Right keyboard shortcuts. Escape closes modal without closing sidebar (stopPropagation wrapper prevents App.tsx global handler from tearing down the panel).
  - Files: src/components/DiffPanel/DiffModal.tsx
- [GD-05] Diff cache with stale-response protection: fileDiffs Map caches parsed diffs per file key (s:/u:/t: prefix). Request counter discards IPC responses from superseded fetches during fast navigation. Cache invalidated on changedPaths from 2s git status poll. Entire cache cleared on session switch.
  - Files: src/components/DiffPanel/DiffPanel.tsx
