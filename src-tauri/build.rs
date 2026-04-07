fn main() {
    // CI sets CLAUDE_CODE_BUILD_VERSION via `npm view @anthropic-ai/claude-code version`.
    // Local dev builds fall back to "unknown".
    if let Ok(v) = std::env::var("CLAUDE_CODE_BUILD_VERSION") {
        println!("cargo:rustc-env=CLAUDE_CODE_BUILD_VERSION={}", v);
    } else {
        println!("cargo:rustc-env=CLAUDE_CODE_BUILD_VERSION=unknown");
    }
    tauri_build::build()
}
