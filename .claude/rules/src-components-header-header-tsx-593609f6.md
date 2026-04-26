---
paths:
  - "src/components/Header/Header.tsx"
---

# src/components/Header/Header.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Version & Auto-Update

- [VA-02 L10] Header (all platforms): compact bar showing app version + CLI version, with window controls (minimize/maximize/close) via Tauri window API. Rendered only when IS_LINUX (custom titlebar replaces OS chrome removed by tauri.conf.json decorations:false). Drag mechanism: 3px-squared movement threshold (DRAG_THRESHOLD_PX_SQ=9) defers startDragging() so single-click and dblclick still register; explicit onDoubleClick handler calls toggleMaximize() since data-tauri-drag-region dblclick path is unreliable on KDE/GNOME Wayland. data-tauri-drag-region attribute removed. Controls cluster (.app-header-controls) is excluded from both drag and dblclick handlers.

## Platform

- [PL-03 L11] Header drag mechanism: DRAG_THRESHOLD_PX_SQ=9 (3px movement) defers startDragging() until the pointer has actually moved past the squared threshold, preserving click and dblclick paths on Wayland compositors. Explicit onDoubleClick handler calls toggleMaximize() because data-tauri-drag-region's dblclick path does not fire reliably on KDE/GNOME Wayland. data-tauri-drag-region attribute removed entirely — startDragging + dblclick are the only drag mechanism. The .app-header-controls cluster is excluded from both drag and dblclick via closest() guard.

## Brand Rename Code Tabs

- [BR-01 L61] 'Claude Tabs' renamed to 'Code Tabs' across: tauri.conf.json productName and window title, index.html <title>, src-tauri/src/lib.rs build expect string, Header label, and App.tsx dynamic window title (format: 'Code Tabs [vX.Y.Z] · Claude X · Codex Y'). App.tsx window title includes both cliVersions.claude and cliVersions.codex ('not installed' when absent).

## Development Rules

- [DR-04 L5] Components in `src/components/<Name>/<Name>.tsx` with co-located CSS
