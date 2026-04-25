import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "../store/sessions";

interface PerProcessPayload {
  pid: number;
  parentCpu: number;
  parentMem: number;
  childrenCpu: number;
  childrenMem: number;
  childCount: number;
}

interface OverallPayload {
  cpu: number;
  mem: number;
  processes: number;
}

/**
 * [PM-06] Frontend pipeline: routes 'process-metrics' events via pidToSessionId; 'process-metrics-overall' sets global chip.
 * Subscribes to the Rust-side process metrics poller (src-tauri/src/metrics.rs).
 * Per-PID events are routed to the right session via the pidToSessionId map
 * populated by ptyProcess.ts on PTY spawn.
 */
export function useProcessMetrics(): void {
  useEffect(() => {
    const unlistenPer = listen<PerProcessPayload>("process-metrics", (event) => {
      const p = event.payload;
      const sid = useSessionStore.getState().pidToSessionId.get(p.pid);
      if (!sid) return;
      useSessionStore.getState().updateProcessTreeMetrics(sid, {
        parentCpu: p.parentCpu,
        parentMemBytes: p.parentMem,
        childrenCpu: p.childrenCpu,
        childrenMemBytes: p.childrenMem,
        childCount: p.childCount,
      });
    });

    const unlistenOverall = listen<OverallPayload>("process-metrics-overall", (event) => {
      const p = event.payload;
      useSessionStore.getState().setOverallMetrics({
        cpu: p.cpu,
        memBytes: p.mem,
        processes: p.processes,
      });
    });

    return () => {
      unlistenPer.then((fn) => fn());
      unlistenOverall.then((fn) => fn());
    };
  }, []);
}
