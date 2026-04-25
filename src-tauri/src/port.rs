//! `.claude/` ↔ `.codex/` content portability.
//!
//! The user's "headline feature": a one-shot operation that copies or
//! translates content between the two CLI ecosystems. Examples:
//!   - Skills directory copy (`SKILL.md` is byte-identical between
//!     Claude and Codex; only the discovery roots differ).
//!   - `CLAUDE.md` ↔ `AGENTS.md` — same role, different filename.
//!   - MCP server config — Claude stores them in `settings.json`
//!     under `mcpServers`, Codex in `config.toml` under
//!     `[mcp_servers.*]`. Schema translation is lossless: the
//!     {command, args, env} shape aligns 1:1.
//!
//! Every Apply is preceded by a tarball backup of the affected paths
//! at `~/.claude_tabs/backups/port-<ts>.tar.gz`. The backup is
//! mandatory: refusal to write the tarball aborts the port.
//!
//! Hooks, slash-command→skill conversion, and `.claude/commands/*.md`
//! ports are deferred — they need partial translation tables that
//! aren't worth shipping until we've finished the parity audit
//! (batch 9).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortDirection {
    /// Claude → Codex
    ClaudeToCodex,
    /// Codex → Claude
    CodexToClaude,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Skip,
    Overwrite,
    Rename,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortReport {
    pub kind: String,
    pub direction: PortDirection,
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    pub backup_path: Option<String>,
    pub messages: Vec<String>,
}

// ── Backup ──────────────────────────────────────────────────────────

/// Write a `.tar.gz` of all paths in `targets` to
/// `~/.claude_tabs/backups/port-<ts>.tar.gz`. Missing paths are
/// silently skipped (we don't want to abort because a target file
/// doesn't exist yet). Returns the backup path.
fn write_backup(targets: &[PathBuf]) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let backup_dir = home.join(".claude_tabs").join("backups");
    fs::create_dir_all(&backup_dir).map_err(|e| format!("create backup dir: {e}"))?;
    let ts = chrono::Local::now().format("%Y%m%dT%H%M%S");
    let backup_path = backup_dir.join(format!("port-{ts}.tar.gz"));
    let file = fs::File::create(&backup_path).map_err(|e| format!("create backup: {e}"))?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    for target in targets {
        if !target.exists() {
            continue;
        }
        let arc_name = target
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "entry".to_string());
        if target.is_dir() {
            tar.append_dir_all(arc_name, target)
                .map_err(|e| format!("tar dir {target:?}: {e}"))?;
        } else {
            tar.append_path_with_name(target, arc_name)
                .map_err(|e| format!("tar file {target:?}: {e}"))?;
        }
    }
    tar.into_inner()
        .and_then(|gz| gz.finish())
        .map_err(|e| format!("finalize backup: {e}"))?;
    Ok(backup_path)
}

// ── Skills directory copy ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortSkillRequest {
    pub direction: PortDirection,
    pub project_dir: String,
    pub skill_name: String,
    pub conflict: ConflictPolicy,
    /// If true, no writes — populate `messages` with what *would* happen.
    pub dry_run: bool,
}

fn skills_root_for(direction: PortDirection, project_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    match direction {
        // Claude → Codex
        PortDirection::ClaudeToCodex => Ok((
            project_dir.join(".claude").join("skills"),
            // Codex's preferred location is ~/.agents/skills, but we
            // copy into the project's .codex/skills/ for project-local
            // ports. User-level ports use ~/.agents/skills/.
            project_dir.join(".codex").join("skills"),
        )),
        // Codex → Claude
        PortDirection::CodexToClaude => {
            // Source: try project .codex/skills first, then .agents/skills, then ~/.agents/skills.
            let candidates = [
                project_dir.join(".codex").join("skills"),
                project_dir.join(".agents").join("skills"),
                home.join(".agents").join("skills"),
                home.join(".codex").join("skills"),
            ];
            for c in &candidates {
                if c.exists() {
                    return Ok((c.clone(), project_dir.join(".claude").join("skills")));
                }
            }
            Err("no Codex skills root found".into())
        }
    }
}

// [PC-01] port_skill/port_memory/port_mcp: .claude/<->.codex/ portability; mandatory tarball backup at ~/.claude_tabs/backups/port-<ts>.tar.gz before any write
#[tauri::command]
pub async fn port_skill(req: PortSkillRequest) -> Result<PortReport, String> {
    tauri::async_runtime::spawn_blocking(move || port_skill_sync(&req))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

pub fn port_skill_sync(req: &PortSkillRequest) -> Result<PortReport, String> {
    let project_dir = PathBuf::from(&req.project_dir);
    let (src_root, dest_root) = skills_root_for(req.direction, &project_dir)?;
    let src = src_root.join(&req.skill_name);
    if !src.exists() {
        return Err(format!("source skill not found: {src:?}"));
    }
    let dest = match req.conflict {
        ConflictPolicy::Rename => {
            let mut suffix = 1u32;
            loop {
                let candidate = dest_root.join(format!("{}-{}", &req.skill_name, suffix));
                if !candidate.exists() {
                    break candidate;
                }
                suffix += 1;
                if suffix > 99 {
                    return Err("rename suffix overflow".into());
                }
            }
        }
        _ => dest_root.join(&req.skill_name),
    };

    let mut written = Vec::new();
    let mut skipped = Vec::new();
    let mut messages = Vec::new();

    if dest.exists() {
        match req.conflict {
            ConflictPolicy::Skip => {
                skipped.push(dest.to_string_lossy().to_string());
                messages.push(format!("destination exists; skipped"));
                return Ok(PortReport {
                    kind: "skill".into(),
                    direction: req.direction,
                    written,
                    skipped,
                    backup_path: None,
                    messages,
                });
            }
            ConflictPolicy::Overwrite => {
                messages.push("destination exists; will overwrite".into());
            }
            ConflictPolicy::Rename => {
                // dest is already a fresh path; no conflict.
            }
        }
    }

    if req.dry_run {
        messages.push(format!("dry-run: would copy {src:?} → {dest:?}"));
        return Ok(PortReport {
            kind: "skill".into(),
            direction: req.direction,
            written,
            skipped,
            backup_path: None,
            messages,
        });
    }

    // Only back up if the destination actually exists. A Rename-to-fresh
    // path produces an empty tarball otherwise, which is misleading.
    let backup_path = if dest.exists() {
        Some(write_backup(&[dest.clone()])?)
    } else {
        None
    };

    if dest.exists() {
        if dest.is_dir() {
            fs::remove_dir_all(&dest).map_err(|e| format!("remove dest: {e}"))?;
        } else {
            fs::remove_file(&dest).map_err(|e| format!("remove dest: {e}"))?;
        }
    }
    fs::create_dir_all(dest.parent().ok_or("dest has no parent")?)
        .map_err(|e| format!("mkdir parent: {e}"))?;
    copy_dir_recursive(&src, &dest, &mut written)?;

    Ok(PortReport {
        kind: "skill".into(),
        direction: req.direction,
        written,
        skipped,
        backup_path: backup_path.map(|p| p.to_string_lossy().to_string()),
        messages,
    })
}

fn copy_dir_recursive(src: &Path, dest: &Path, written: &mut Vec<String>) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("mkdir {dest:?}: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to, written)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("copy {from:?} → {to:?}: {e}"))?;
            written.push(to.to_string_lossy().to_string());
        }
    }
    Ok(())
}

// ── CLAUDE.md ↔ AGENTS.md ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMemoryRequest {
    pub direction: PortDirection,
    pub project_dir: String,
    pub conflict: ConflictPolicy,
    /// Symlink instead of copy so future edits stay in sync.
    pub symlink: bool,
    pub dry_run: bool,
}

#[tauri::command]
pub async fn port_memory(req: PortMemoryRequest) -> Result<PortReport, String> {
    tauri::async_runtime::spawn_blocking(move || port_memory_sync(&req))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

pub fn port_memory_sync(req: &PortMemoryRequest) -> Result<PortReport, String> {
    let project_dir = PathBuf::from(&req.project_dir);
    let (src, dest) = match req.direction {
        PortDirection::ClaudeToCodex => (project_dir.join("CLAUDE.md"), project_dir.join("AGENTS.md")),
        PortDirection::CodexToClaude => (project_dir.join("AGENTS.md"), project_dir.join("CLAUDE.md")),
    };

    let mut written = Vec::new();
    let mut skipped = Vec::new();
    let mut messages = Vec::new();

    if !src.exists() {
        return Err(format!("source missing: {src:?}"));
    }

    if dest.exists() {
        match req.conflict {
            ConflictPolicy::Skip => {
                skipped.push(dest.to_string_lossy().to_string());
                messages.push("destination exists; skipped".into());
                return Ok(PortReport {
                    kind: "memory".into(),
                    direction: req.direction,
                    written,
                    skipped,
                    backup_path: None,
                    messages,
                });
            }
            ConflictPolicy::Overwrite => messages.push("will overwrite destination".into()),
            ConflictPolicy::Rename => {
                return Err("rename policy not supported for memory port".into());
            }
        }
    }

    if req.dry_run {
        let action = if req.symlink { "symlink" } else { "copy" };
        messages.push(format!("dry-run: would {action} {src:?} → {dest:?}"));
        return Ok(PortReport {
            kind: "memory".into(),
            direction: req.direction,
            written,
            skipped,
            backup_path: None,
            messages,
        });
    }

    let backup_path = write_backup(&[dest.clone()])?;

    if dest.exists() {
        fs::remove_file(&dest).map_err(|e| format!("remove dest: {e}"))?;
    }

    if req.symlink {
        #[cfg(unix)]
        std::os::unix::fs::symlink(&src, &dest)
            .map_err(|e| format!("symlink {src:?} → {dest:?}: {e}"))?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&src, &dest)
            .map_err(|e| format!("symlink {src:?} → {dest:?}: {e}"))?;
        messages.push("symlinked".into());
    } else {
        fs::copy(&src, &dest).map_err(|e| format!("copy: {e}"))?;
    }
    written.push(dest.to_string_lossy().to_string());

    Ok(PortReport {
        kind: "memory".into(),
        direction: req.direction,
        written,
        skipped,
        backup_path: Some(backup_path.to_string_lossy().to_string()),
        messages,
    })
}

// ── MCP servers (JSON ↔ TOML) ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMcpRequest {
    pub direction: PortDirection,
    pub conflict: ConflictPolicy,
    pub dry_run: bool,
    /// If true, port the *user-level* file (~/.claude/settings.json or
    /// ~/.codex/config.toml). If false, port the project-local file
    /// at `project_dir`.
    pub user_scope: bool,
    pub project_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transport: Option<String>,
}

#[tauri::command]
pub async fn port_mcp(req: PortMcpRequest) -> Result<PortReport, String> {
    tauri::async_runtime::spawn_blocking(move || port_mcp_sync(&req))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

pub fn port_mcp_sync(req: &PortMcpRequest) -> Result<PortReport, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let (claude_path, codex_path) = if req.user_scope {
        (
            home.join(".claude").join("settings.json"),
            home.join(".codex").join("config.toml"),
        )
    } else {
        let project = PathBuf::from(req.project_dir.as_deref().unwrap_or("."));
        (
            project.join(".claude").join("settings.json"),
            project.join(".codex").join("config.toml"),
        )
    };
    let (src_path, dest_path, src_kind, dest_kind) = match req.direction {
        PortDirection::ClaudeToCodex => (&claude_path, &codex_path, "claude_json", "codex_toml"),
        PortDirection::CodexToClaude => (&codex_path, &claude_path, "codex_toml", "claude_json"),
    };

    let mut written = Vec::new();
    let mut skipped = Vec::new();
    let mut messages = Vec::new();

    if !src_path.exists() {
        return Err(format!("source missing: {src_path:?}"));
    }

    let servers = read_mcp_from(src_path, src_kind)?;
    if servers.is_empty() {
        messages.push("no MCP servers found in source; nothing to port".into());
        return Ok(PortReport {
            kind: "mcp".into(),
            direction: req.direction,
            written,
            skipped,
            backup_path: None,
            messages,
        });
    }
    messages.push(format!("read {} MCP server(s) from {src_path:?}", servers.len()));

    if req.dry_run {
        for name in servers.keys() {
            messages.push(format!("dry-run: would write server '{name}' to {dest_path:?}"));
        }
        return Ok(PortReport {
            kind: "mcp".into(),
            direction: req.direction,
            written,
            skipped,
            backup_path: None,
            messages,
        });
    }

    let backup_path = write_backup(&[dest_path.clone()])?;

    let merged = merge_mcp_into(dest_path, dest_kind, servers, req.conflict, &mut skipped, &mut messages)?;

    fs::create_dir_all(dest_path.parent().ok_or("dest has no parent")?)
        .map_err(|e| format!("mkdir parent: {e}"))?;
    fs::write(dest_path, merged).map_err(|e| format!("write dest: {e}"))?;
    written.push(dest_path.to_string_lossy().to_string());

    Ok(PortReport {
        kind: "mcp".into(),
        direction: req.direction,
        written,
        skipped,
        backup_path: Some(backup_path.to_string_lossy().to_string()),
        messages,
    })
}

fn read_mcp_from(path: &Path, kind: &str) -> Result<BTreeMap<String, McpServerEntry>, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read {path:?}: {e}"))?;
    match kind {
        "claude_json" => {
            let v: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("invalid JSON in {path:?}: {e}"))?;
            let map = v
                .get("mcpServers")
                .and_then(|x| x.as_object())
                .cloned()
                .unwrap_or_default();
            let mut out = BTreeMap::new();
            for (k, v) in map {
                if let Ok(entry) = serde_json::from_value::<McpServerEntry>(v) {
                    out.insert(k, entry);
                }
            }
            Ok(out)
        }
        "codex_toml" => {
            let v: toml::Value = toml::from_str(&raw)
                .map_err(|e| format!("invalid TOML in {path:?}: {e}"))?;
            let map = v
                .get("mcp_servers")
                .and_then(|x| x.as_table())
                .cloned()
                .unwrap_or_default();
            let mut out = BTreeMap::new();
            for (k, v) in map {
                let json = serde_json::to_value(v).map_err(|e| format!("toml→json: {e}"))?;
                if let Ok(entry) = serde_json::from_value::<McpServerEntry>(json) {
                    out.insert(k, entry);
                }
            }
            Ok(out)
        }
        _ => Err(format!("unknown source kind: {kind}")),
    }
}

fn merge_mcp_into(
    dest: &Path,
    kind: &str,
    incoming: BTreeMap<String, McpServerEntry>,
    conflict: ConflictPolicy,
    skipped: &mut Vec<String>,
    messages: &mut Vec<String>,
) -> Result<String, String> {
    match kind {
        "claude_json" => {
            let mut existing: serde_json::Value = if dest.exists() {
                let raw = fs::read_to_string(dest).map_err(|e| format!("read dest: {e}"))?;
                serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
            } else {
                serde_json::json!({})
            };
            let obj = existing.as_object_mut().ok_or("dest is not a JSON object")?;
            let map = obj
                .entry("mcpServers".to_string())
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or("mcpServers is not an object")?;
            for (name, entry) in incoming {
                if map.contains_key(&name) {
                    match conflict {
                        ConflictPolicy::Skip => {
                            skipped.push(name);
                            continue;
                        }
                        ConflictPolicy::Overwrite => {}
                        ConflictPolicy::Rename => {
                            let renamed = format!("{name}-codex");
                            messages.push(format!("conflict: '{name}' renamed to '{renamed}'"));
                            map.insert(
                                renamed,
                                serde_json::to_value(entry)
                                    .map_err(|e| format!("serialize MCP entry: {e}"))?,
                            );
                            continue;
                        }
                    }
                }
                map.insert(
                    name,
                    serde_json::to_value(entry)
                        .map_err(|e| format!("serialize MCP entry: {e}"))?,
                );
            }
            Ok(serde_json::to_string_pretty(&existing)
                .map_err(|e| format!("serialize JSON: {e}"))?)
        }
        "codex_toml" => {
            let mut existing: toml::Value = if dest.exists() {
                let raw = fs::read_to_string(dest).map_err(|e| format!("read dest: {e}"))?;
                toml::from_str(&raw).unwrap_or_else(|_| toml::Value::Table(toml::value::Table::new()))
            } else {
                toml::Value::Table(toml::value::Table::new())
            };
            let table = existing
                .as_table_mut()
                .ok_or("dest TOML root is not a table")?;
            let mcp_servers = table
                .entry("mcp_servers".to_string())
                .or_insert_with(|| toml::Value::Table(toml::value::Table::new()))
                .as_table_mut()
                .ok_or("mcp_servers is not a table")?;
            for (name, entry) in incoming {
                if mcp_servers.contains_key(&name) {
                    match conflict {
                        ConflictPolicy::Skip => {
                            skipped.push(name);
                            continue;
                        }
                        ConflictPolicy::Overwrite => {}
                        ConflictPolicy::Rename => {
                            let renamed = format!("{name}-claude");
                            messages.push(format!("conflict: '{name}' renamed to '{renamed}'"));
                            let json = serde_json::to_value(entry)
                                .map_err(|e| format!("serialize MCP entry: {e}"))?;
                            let toml_val: toml::Value = json_to_toml(json);
                            mcp_servers.insert(renamed, toml_val);
                            continue;
                        }
                    }
                }
                let json = serde_json::to_value(entry)
                    .map_err(|e| format!("serialize MCP entry: {e}"))?;
                let toml_val: toml::Value = json_to_toml(json);
                mcp_servers.insert(name, toml_val);
            }
            Ok(toml::to_string(&existing).map_err(|e| format!("serialize TOML: {e}"))?)
        }
        _ => Err(format!("unknown dest kind: {kind}")),
    }
}

fn json_to_toml(v: serde_json::Value) -> toml::Value {
    match v {
        serde_json::Value::Null => toml::Value::String(String::new()),
        serde_json::Value::Bool(b) => toml::Value::Boolean(b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                toml::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                toml::Value::Float(f)
            } else {
                toml::Value::String(n.to_string())
            }
        }
        serde_json::Value::String(s) => toml::Value::String(s),
        serde_json::Value::Array(a) => toml::Value::Array(a.into_iter().map(json_to_toml).collect()),
        serde_json::Value::Object(o) => {
            let mut t = toml::value::Table::new();
            for (k, v) in o {
                t.insert(k, json_to_toml(v));
            }
            toml::Value::Table(t)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ct-port-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn skill_port_claude_to_codex_copies_dir() {
        let proj = tmpdir("skill-c2c");
        let src = proj.join(".claude").join("skills").join("greet");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "---\nname: greet\n---\nbody").unwrap();
        let req = PortSkillRequest {
            direction: PortDirection::ClaudeToCodex,
            project_dir: proj.to_string_lossy().to_string(),
            skill_name: "greet".into(),
            conflict: ConflictPolicy::Overwrite,
            dry_run: false,
        };
        let report = port_skill_sync(&req).expect("port");
        assert!(!report.written.is_empty());
        assert!(proj.join(".codex/skills/greet/SKILL.md").exists());
        // First-time port (no destination existed): no backup needed.
        assert!(report.backup_path.is_none());
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn skill_port_dry_run_does_not_write() {
        let proj = tmpdir("skill-dry");
        let src = proj.join(".claude").join("skills").join("foo");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "body").unwrap();
        let req = PortSkillRequest {
            direction: PortDirection::ClaudeToCodex,
            project_dir: proj.to_string_lossy().to_string(),
            skill_name: "foo".into(),
            conflict: ConflictPolicy::Overwrite,
            dry_run: true,
        };
        let report = port_skill_sync(&req).expect("port dry");
        assert!(report.written.is_empty());
        assert!(report.backup_path.is_none());
        assert!(!proj.join(".codex/skills/foo/SKILL.md").exists());
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn skill_port_skip_conflict() {
        let proj = tmpdir("skill-skip");
        let src = proj.join(".claude/skills/dup");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "fresh").unwrap();
        let dest = proj.join(".codex/skills/dup");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("SKILL.md"), "existing").unwrap();
        let req = PortSkillRequest {
            direction: PortDirection::ClaudeToCodex,
            project_dir: proj.to_string_lossy().to_string(),
            skill_name: "dup".into(),
            conflict: ConflictPolicy::Skip,
            dry_run: false,
        };
        let report = port_skill_sync(&req).expect("port");
        assert!(!report.skipped.is_empty());
        let dest_body = fs::read_to_string(dest.join("SKILL.md")).unwrap();
        assert_eq!(dest_body, "existing", "destination should remain untouched");
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn memory_port_copies_claude_md_to_agents_md() {
        let proj = tmpdir("mem-c2c");
        fs::write(proj.join("CLAUDE.md"), "claude doc").unwrap();
        let req = PortMemoryRequest {
            direction: PortDirection::ClaudeToCodex,
            project_dir: proj.to_string_lossy().to_string(),
            conflict: ConflictPolicy::Overwrite,
            symlink: false,
            dry_run: false,
        };
        let report = port_memory_sync(&req).expect("port");
        assert_eq!(fs::read_to_string(proj.join("AGENTS.md")).unwrap(), "claude doc");
        assert_eq!(report.written.len(), 1);
        assert!(report.backup_path.is_some());
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn mcp_port_claude_to_codex_emits_toml_table() {
        let proj = tmpdir("mcp-c2c");
        let claude = proj.join(".claude").join("settings.json");
        fs::create_dir_all(claude.parent().unwrap()).unwrap();
        let json = serde_json::json!({
            "mcpServers": {
                "fs": { "command": "fs-server", "args": ["--root", "/tmp"], "env": { "X": "1" } }
            }
        });
        fs::write(&claude, serde_json::to_string_pretty(&json).unwrap()).unwrap();
        let req = PortMcpRequest {
            direction: PortDirection::ClaudeToCodex,
            conflict: ConflictPolicy::Overwrite,
            dry_run: false,
            user_scope: false,
            project_dir: Some(proj.to_string_lossy().to_string()),
        };
        let report = port_mcp_sync(&req).expect("port");
        assert!(report.backup_path.is_some());
        let codex_text = fs::read_to_string(proj.join(".codex/config.toml")).unwrap();
        assert!(codex_text.contains("[mcp_servers.fs]"));
        assert!(codex_text.contains("command = \"fs-server\""));
        assert!(codex_text.contains("--root"));
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn mcp_port_codex_to_claude_round_trips_via_toml() {
        let proj = tmpdir("mcp-codex2c");
        let codex = proj.join(".codex").join("config.toml");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::write(
            &codex,
            "[mcp_servers.web]\nurl = \"https://example.com\"\ntransport = \"sse\"\n",
        )
        .unwrap();
        let req = PortMcpRequest {
            direction: PortDirection::CodexToClaude,
            conflict: ConflictPolicy::Overwrite,
            dry_run: false,
            user_scope: false,
            project_dir: Some(proj.to_string_lossy().to_string()),
        };
        let report = port_mcp_sync(&req).expect("port");
        assert!(!report.written.is_empty());
        let claude: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(proj.join(".claude/settings.json")).unwrap())
                .unwrap();
        assert_eq!(
            claude["mcpServers"]["web"]["url"],
            serde_json::Value::String("https://example.com".into())
        );
        assert_eq!(
            claude["mcpServers"]["web"]["transport"],
            serde_json::Value::String("sse".into())
        );
        let _ = fs::remove_dir_all(&proj);
    }

    #[test]
    fn mcp_port_rename_conflict_appends_suffix() {
        let proj = tmpdir("mcp-rename");
        let claude = proj.join(".claude").join("settings.json");
        fs::create_dir_all(claude.parent().unwrap()).unwrap();
        fs::write(
            &claude,
            r#"{"mcpServers":{"fs":{"command":"src","args":[]}}}"#,
        )
        .unwrap();
        let codex = proj.join(".codex").join("config.toml");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::write(
            &codex,
            "[mcp_servers.fs]\ncommand = \"existing\"\n",
        )
        .unwrap();
        let req = PortMcpRequest {
            direction: PortDirection::ClaudeToCodex,
            conflict: ConflictPolicy::Rename,
            dry_run: false,
            user_scope: false,
            project_dir: Some(proj.to_string_lossy().to_string()),
        };
        port_mcp_sync(&req).expect("port");
        let toml_text = fs::read_to_string(&codex).unwrap();
        // Original entry preserved.
        assert!(toml_text.contains("[mcp_servers.fs]"), "missing original fs entry; got:\n{toml_text}");
        assert!(toml_text.contains("command = \"existing\""));
        // Renamed entry from Claude side gets a -claude suffix (the
        // suffix names which side the incoming entry came from).
        assert!(
            toml_text.contains("[mcp_servers.fs-claude]"),
            "missing renamed fs-claude entry; got:\n{toml_text}"
        );
        assert!(toml_text.contains("command = \"src\""));
        let _ = fs::remove_dir_all(&proj);
    }
}
