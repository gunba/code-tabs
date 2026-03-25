# Release

Build commands, version locations, and release workflow for Claude Tabs.

## Build Commands

```bash
npm run build:quick     # Release binary, no installer (~30s after first build)
npm run build:debug     # Debug binary, fastest (~10-15s incremental)
npm run tauri dev       # Dev mode with hot-reload
npm run tauri build     # Full NSIS installer (only for releases)
```

### Outputs

- **Portable exe**: `src-tauri/target/release/claude-tabs.exe`
- **NSIS installer**: `src-tauri/target/release/bundle/nsis/Claude Tabs_<version>_x64-setup.exe`

Never do a full NSIS build just to test. Use `build:quick` or `build:debug`.

## Validation Before Build

```bash
npx tsc --noEmit           # Zero TypeScript errors
npm test                   # All Vitest unit tests pass
cd src-tauri && cargo check # Zero Rust errors
```

## Version Locations

Version must be bumped in all three files:
- `package.json` — `version` field
- `src-tauri/tauri.conf.json` — `version` field
- `src-tauri/Cargo.toml` — `version` field under `[package]`

## Release Workflow

1. Bump version in all three files
2. Run validation (tsc + test + cargo check)
3. Build locally with `build:quick` to verify compilation
4. Commit version bump, push with tag:
   ```bash
   git tag v<version>
   git push origin master --tags
   ```
5. Create GitHub release (no artifacts — CI handles uploads):
   ```bash
   gh release create v<version> --title "v<version>" --generate-notes
   ```

CI workflows (`.github/workflows/build-windows.yml` and `build-linux.yml`) trigger on the `v*` tag push and upload platform artifacts automatically:
- **Windows**: NSIS installer + `claude-tabs-windows-portable.exe`
- **Linux**: `.deb`, `.rpm`, `.AppImage` + `claude-tabs-linux-portable`

Both workflows include a release-existence guard — whichever finishes first creates the release if `/b` hasn't already, the other appends with `--clobber`.

## Build Notes

Build optimization log. `/b` appends findings and improvements here.

### v0.10.0 — Linker + profile optimizations (2026-03-22)

Added `src-tauri/.cargo/config.toml` with `rust-lld` linker, plus `strip = true` and `panic = "abort"` in release profile.

- **Before**: incremental release Rust compile ~88s
- **After**: incremental release Rust compile ~34s (62% faster)
- Binary: 8.3MB portable, 2.5MB installer (smaller due to strip + panic=abort)
- Full NSIS build wall time: ~46s incremental (was ~90s)
