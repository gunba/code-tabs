const COMMANDS: &[&str] = &[
    "spawn", "write", "read", "resize", "kill", "exitstatus", "destroy", "get_child_pid",
    "drain_output",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
