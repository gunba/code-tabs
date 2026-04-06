import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { trace, traceAsync } from "../lib/perfTrace";
import { dlog } from "../lib/debugLog";
import type { SlashCommand } from "../store/settings";

function mergeCommands(...lists: SlashCommand[][]): SlashCommand[] {
  const map = new Map<string, SlashCommand>();
  for (const list of lists) {
    for (const cmd of list) {
      const existing = map.get(cmd.cmd);
      if (!existing || (cmd.desc && cmd.desc.length > (existing.desc?.length ?? 0))) {
        map.set(cmd.cmd, cmd);
      }
    }
  }
  return Array.from(map.values());
}

async function discover() {
  trace("commandDiscovery: start");
  const sessions = useSessionStore.getState().sessions;
  const recentDirs = useSettingsStore.getState().recentDirs;
  const projectDirs = [
    ...new Set([
      ...sessions.map((s) => s.config.workingDir).filter(Boolean),
      ...recentDirs,
    ]),
  ];

  const claudePath = useSessionStore.getState().claudePath;
  dlog("discovery", null, "slash command discovery started", "LOG", {
    event: "discovery.slash_commands_started",
    data: {
      claudePath,
      projectDirs,
    },
  });
  const builtinPromise = traceAsync("commandDiscovery: discover_builtin_commands", () =>
    invoke<Array<{ cmd: string; desc: string }>>("discover_builtin_commands", { cliPath: claudePath })
  , {
    module: "discovery",
    event: "discovery.builtin_commands_perf",
    warnAboveMs: 500,
    data: { claudePath },
  }).then((commands) => {
    dlog("discovery", null, "builtin slash command discovery completed", "LOG", {
      event: "discovery.builtin_commands_loaded",
      data: {
        count: commands.length,
        commands: commands.map((command) => command.cmd),
      },
    });
    return commands;
  }).catch((err) => {
    dlog("discovery", null, `builtin slash command discovery failed: ${err}`, "WARN", {
      event: "discovery.builtin_commands_failed",
      data: { error: String(err) },
    });
    return [] as Array<{ cmd: string; desc: string }>;
  });

  const pluginPromise = traceAsync("commandDiscovery: discover_plugin_commands", () =>
    invoke<Array<{ cmd: string; desc: string }>>("discover_plugin_commands", { extraDirs: projectDirs })
  , {
    module: "discovery",
    event: "discovery.plugin_commands_perf",
    warnAboveMs: 500,
    data: { projectDirs },
  }).then((commands) => {
    dlog("discovery", null, "plugin slash command discovery completed", "LOG", {
      event: "discovery.plugin_commands_loaded",
      data: {
        count: commands.length,
        commands: commands.map((command) => command.cmd),
        projectDirs,
      },
    });
    return commands;
  }).catch((err) => {
    dlog("discovery", null, `plugin slash command discovery failed: ${err}`, "WARN", {
      event: "discovery.plugin_commands_failed",
      data: {
        error: String(err),
        projectDirs,
      },
    });
    return [] as Array<{ cmd: string; desc: string }>;
  });

  // Fallback: parse --help output for slash commands when binary scan fails
  // (binary may not exist on machines without admin or on first install)
  const helpPromise = traceAsync("commandDiscovery: get_cli_help", () =>
    invoke<string>("get_cli_help")
  , {
    module: "discovery",
    event: "discovery.help_commands_perf",
    warnAboveMs: 500,
    data: {},
  }).then((help) => {
    const cmds: Array<{ cmd: string; desc: string }> = [];
    // Match lines like "  /command    Description text"
    const re = /^\s+(\/[\w-]+)\s{2,}(.+)$/gm;
    let m;
    while ((m = re.exec(help)) !== null) {
      cmds.push({ cmd: m[1], desc: m[2].trim() });
    }
    dlog("discovery", null, "help-based slash command discovery completed", "DEBUG", {
      event: "discovery.help_commands_loaded",
      data: {
        count: cmds.length,
        commands: cmds.map((command) => command.cmd),
      },
    });
    return cmds;
  }).catch((err) => {
    dlog("discovery", null, `help-based slash command discovery failed: ${err}`, "WARN", {
      event: "discovery.help_commands_failed",
      data: { error: String(err) },
    });
    return [] as Array<{ cmd: string; desc: string }>;
  });

  const [builtins, plugins, helpCmds] = await Promise.all([builtinPromise, pluginPromise, helpPromise]);

  const toSlash = (arr: Array<{ cmd: string; desc: string }>): SlashCommand[] =>
    arr.filter((c) => typeof c.cmd === "string" && c.cmd.startsWith("/"));

  // Merge all sources — binary scan has best descriptions, --help is fallback
  const merged = mergeCommands(toSlash(builtins), toSlash(helpCmds), toSlash(plugins));
  useSettingsStore.getState().setSlashCommands(merged);
  dlog("discovery", null, "slash command discovery merged", "LOG", {
    event: "discovery.slash_commands_merged",
    data: {
      builtinCount: builtins.length,
      helpCount: helpCmds.length,
      pluginCount: plugins.length,
      mergedCount: merged.length,
      commands: merged.map((command) => command.cmd),
    },
  });

  // Scan command usage from JSONL history (refreshed each launch)
  useSettingsStore.getState().bootstrapCommandUsage();
}

// Discovers slash commands from Claude Code binary + plugin/project directory scans.
// Discovery is deferred until terminal sessions have loaded to avoid competing for
// disk I/O and CPU — reading the Claude binary (100MB+) and spawning `claude --help`
// would otherwise slow down the terminal's Claude process on Windows.
export function useCommandDiscovery(): void {
  const discoveredRef = useRef(false);
  // Wait for terminal sessions to finish loading before starting discovery.
  // Active sessions in "starting" state mean the Claude process is still booting;
  // heavy I/O from binary scanning and subprocess spawns would compete with it.
  const ready = useSessionStore((s) => {
    if (!s.claudePath) return false;
    // No active sessions → no contention; otherwise wait for at least one past startup
    return s.sessions.every((sess) => sess.state === "dead")
      || s.sessions.some((sess) => sess.state !== "dead" && sess.state !== "starting");
  });

  const refreshTrigger = useSettingsStore((s) => s.commandRefreshTrigger);

  useEffect(() => {
    if (discoveredRef.current || !ready) return;

    // Extra buffer to let the terminal's Claude process fully boot
    const timer = setTimeout(() => {
      discoveredRef.current = true;
      discover();
    }, 3000);
    return () => clearTimeout(timer);
  }, [ready]);

  // Re-run discovery when skills are created/edited/deleted
  useEffect(() => {
    if (refreshTrigger === 0) return;
    discover();
  }, [refreshTrigger]);
}
