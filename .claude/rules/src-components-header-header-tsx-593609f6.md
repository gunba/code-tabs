---
paths:
  - "src/components/Header/Header.tsx"
---

# src/components/Header/Header.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Version & Auto-Update

- [VA-02 L9] Header (all platforms): compact bar showing app version + CLI version, with window controls (minimize/maximize/close) via Tauri window API. Rendered only when IS_LINUX (custom titlebar replaces OS chrome removed by tauri.conf.json decorations:false). Drag mechanism: 3px-squared movement threshold (DRAG_THRESHOLD_PX_SQ=9) defers startDragging() so single-click and dblclick still register; explicit onDoubleClick handler calls toggleMaximize() since data-tauri-drag-region dblclick path is unreliable on KDE/GNOME Wayland. data-tauri-drag-region attribute removed. Controls cluster (.app-header-controls) is excluded from both drag and dblclick handlers.

## Platform

- [PL-03 L10] Header drag mechanism: DRAG_THRESHOLD_PX_SQ=9 (3px movement) defers startDragging() until the pointer has actually moved past the squared threshold, preserving click and dblclick paths on Wayland compositors. Explicit onDoubleClick handler calls toggleMaximize() because data-tauri-drag-region's dblclick path does not fire reliably on KDE/GNOME Wayland. data-tauri-drag-region attribute removed entirely — startDragging + dblclick are the only drag mechanism. The .app-header-controls cluster is excluded from both drag and dblclick via closest() guard.
