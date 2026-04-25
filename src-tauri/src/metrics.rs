use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::ActivePids;

const POLL_INTERVAL: Duration = Duration::from_millis(1000);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessMetricsPayload {
    pid: u32,
    parent_cpu: f32,
    parent_mem: u64,
    children_cpu: f32,
    children_mem: u64,
    child_count: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverallMetricsPayload {
    cpu: f32,
    mem: u64,
    processes: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppProcessMetricsPayload {
    pid: u32,
    cpu: f32,
    mem: u64,
    children_cpu: f32,
    children_mem: u64,
    child_count: u32,
}

/// Spawn the per-tab CPU/memory poller. Runs for the lifetime of the app.
/// Reads tracked PIDs from `ActivePids` (registered by the frontend on PTY spawn),
/// walks the full descendant tree, and emits two Tauri events per tick:
///   - `process-metrics` — one event per tracked parent PID
///   - `process-metrics-overall` — single sum across all tracked trees
pub fn spawn_collector(app: AppHandle) {
    thread::spawn(move || {
        let mut system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_processes(ProcessRefreshKind::nothing().with_cpu().with_memory()),
        );
        let cpu_count = num_logical_cpus(&system).max(1) as f32;
        let app_pid = std::process::id();

        // Prime CPU counters — sysinfo needs two refreshes for non-zero values.
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        loop {
            thread::sleep(POLL_INTERVAL);

            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );

            let tracked: Vec<u32> = match app.try_state::<ActivePids>() {
                Some(state) => match state.0.lock() {
                    Ok(set) => set.iter().copied().collect(),
                    Err(_) => continue,
                },
                None => continue,
            };

            // Build parent → children index once per tick (O(N) instead of O(N²) per BFS).
            let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();
            for (pid, process) in system.processes() {
                if let Some(parent) = process.parent() {
                    children_of
                        .entry(parent.as_u32())
                        .or_default()
                        .push(pid.as_u32());
                }
            }

            if let Some(app_proc) = system.process(Pid::from_u32(app_pid)) {
                let (children_cpu, children_mem, child_count) =
                    sum_descendants(&system, &children_of, app_pid);
                let _ = app.emit(
                    "app-process-metrics",
                    AppProcessMetricsPayload {
                        pid: app_pid,
                        cpu: app_proc.cpu_usage() / cpu_count,
                        mem: app_proc.memory(),
                        children_cpu: children_cpu / cpu_count,
                        children_mem,
                        child_count,
                    },
                );
            }

            let mut overall_cpu: f32 = 0.0;
            let mut overall_mem: u64 = 0;
            let mut overall_proc_count: u32 = 0;

            for root_pid in tracked {
                let Some(parent_proc) = system.process(Pid::from_u32(root_pid)) else {
                    continue;
                };
                let parent_cpu = parent_proc.cpu_usage();
                let parent_mem = parent_proc.memory();

                let mut children_cpu: f32 = 0.0;
                let mut children_mem: u64 = 0;
                let mut child_count: u32 = 0;

                let mut queue: Vec<u32> = children_of.get(&root_pid).cloned().unwrap_or_default();
                let mut visited: std::collections::HashSet<u32> = std::collections::HashSet::new();
                visited.insert(root_pid);
                while let Some(pid) = queue.pop() {
                    if !visited.insert(pid) {
                        continue;
                    }
                    if let Some(proc_info) = system.process(Pid::from_u32(pid)) {
                        children_cpu += proc_info.cpu_usage();
                        children_mem += proc_info.memory();
                        child_count += 1;
                    }
                    if let Some(grand) = children_of.get(&pid) {
                        queue.extend(grand.iter().copied());
                    }
                }

                let total_proc = 1 + child_count;
                overall_cpu += parent_cpu + children_cpu;
                overall_mem += parent_mem + children_mem;
                overall_proc_count += total_proc;

                let payload = ProcessMetricsPayload {
                    pid: root_pid,
                    parent_cpu: parent_cpu / cpu_count,
                    parent_mem,
                    children_cpu: children_cpu / cpu_count,
                    children_mem,
                    child_count,
                };
                let _ = app.emit("process-metrics", payload);
            }

            let overall = OverallMetricsPayload {
                cpu: overall_cpu / cpu_count,
                mem: overall_mem,
                processes: overall_proc_count,
            };
            let _ = app.emit("process-metrics-overall", overall);
        }
    });
}

fn num_logical_cpus(system: &System) -> usize {
    let n = system.cpus().len();
    if n > 0 {
        return n;
    }
    System::new_all().cpus().len().max(1)
}

fn sum_descendants(
    system: &System,
    children_of: &HashMap<u32, Vec<u32>>,
    root_pid: u32,
) -> (f32, u64, u32) {
    let mut children_cpu: f32 = 0.0;
    let mut children_mem: u64 = 0;
    let mut child_count: u32 = 0;
    let mut queue: Vec<u32> = children_of.get(&root_pid).cloned().unwrap_or_default();
    let mut visited: std::collections::HashSet<u32> = std::collections::HashSet::new();
    visited.insert(root_pid);
    while let Some(pid) = queue.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(proc_info) = system.process(Pid::from_u32(pid)) {
            children_cpu += proc_info.cpu_usage();
            children_mem += proc_info.memory();
            child_count += 1;
        }
        if let Some(grand) = children_of.get(&pid) {
            queue.extend(grand.iter().copied());
        }
    }
    (children_cpu, children_mem, child_count)
}
