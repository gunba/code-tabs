---
paths:
  - "src-tauri/src/lib.rs"
---

# src-tauri/src/lib.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Linux platform workarounds
Startup env vars and runtime tweaks needed for webkit2gtk/Wayland/KDE to work reliably as a Tauri host.

- [LP-01 L93] At Rust startup (lib.rs run()), force GDK_BACKEND=x11, WEBKIT_DISABLE_COMPOSITING_MODE=0, WEBKIT_DISABLE_DMABUF_RENDERER=1 before tauri::Builder runs. Runs under Xwayland to avoid Wayland explicit-sync protocol Error 71 on NVIDIA (kwin rejects wp_linux_drm_syncobj_v1 commits). COMPOSITING_MODE=0 keeps accelerated compositing on (CSS animations stay compositor-only, xterm WebGL canvas stays GPU-resident). DMABUF disabled because Xwayland uses X11 buffer sharing. Pre-existing env values are honored so power users can opt back in.
  - src-tauri/src/lib.rs:L93

## Rust System Command Modules

- [RC-11 L302] register_active_pid / unregister_active_pid -- Frontend registers OS PIDs of PTY children; RunEvent::Exit handler in lib.rs iterates ActivePids and calls kill_process_tree_sync for each.

## Window

- [WN-01 L146] Native Windows decorations with dark theme — no custom HTML titlebar or window control buttons

## PTY Spawn

- [PT-07 L20] OS PID registered in global cleanup registry (ptyProcess.ts) immediately on PTY spawn; unregistered on explicit kill. Dual-layer: frontend fires kill_process_tree on beforeunload, Rust ActivePids state kills on RunEvent::Exit as backstop.
- [PT-03 L118] CLAUDECODE env var is stripped at Rust app startup (lib.rs) so spawned PTYs do not think they are nested inside another Claude Code session.
