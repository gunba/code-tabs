---
paths:
  - "src/store/version.ts"
---

# src/store/version.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Version & Auto-Update

- [VA-01 L1] Tauri updater plugin checks GitHub releases for app updates. version.ts Zustand store manages lifecycle: loadBuildInfo (Rust get_build_info → CARGO_PKG_VERSION + CLAUDE_CODE_BUILD_VERSION), checkForAppUpdate (tauri-plugin-updater check()), downloadAndInstallAppUpdate (download + relaunch()), checkLatestCliVersion (npm dist-tags endpoint), updateCli (detects install method from CLI path, runs appropriate update command). All called from App.tsx startup.
