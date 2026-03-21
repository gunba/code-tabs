import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../store/settings";
import { trace, traceAsync } from "../lib/perfTrace";
import type { CliCapabilities, CliOption, CliCommand } from "../store/settings";

/**
 * On app start, checks the Claude CLI version and help text.
 * If the version has changed since last check, parses new capabilities
 * and notifies via the meta-agent panel.
 */
export function useCliWatcher(): void {
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    // Defer so the UI is interactive before spawning subprocesses
    const timer = setTimeout(() => check(), 500);
    return () => clearTimeout(timer);

    async function check() {
      try {
        trace("cliWatcher: check start");
        const version = await traceAsync("cliWatcher: check_cli_version", () =>
          invoke<string>("check_cli_version")
        );
        const cached = useSettingsStore.getState().cliVersion;

        // Always re-parse on startup — the help text is fast to parse
        // and we need fresh data when new flags are added to the CLI.
        if (version) {
          // Version changed — parse help for capabilities
          try {
            const help = await traceAsync("cliWatcher: get_cli_help", () =>
              invoke<string>("get_cli_help")
            );
            const capabilities = parseHelpText(help);
            useSettingsStore.getState().setCliCapabilities(version, capabilities);
          } catch {
            // Help failed but version succeeded — still update version
            useSettingsStore.getState().setCliCapabilities(version, {
              models: [],
              permissionModes: [],
              flags: [],
              options: [],
              commands: [],
            });
          }

          // Discover settings schema from binary (runs in background, non-blocking)
          useSettingsStore.getState().loadBinarySettingsSchema();

          // Log version change
          if (cached) {
            console.info(`[cliWatcher] Claude CLI updated: ${cached} → ${version}`);
          }
        }
      } catch {
        // CLI not found or version check failed — ignore
      }
    }
  }, []);
}

export function parseHelpText(help: string): CliCapabilities {
  const models: string[] = [];
  const permissionModes: string[] = [];
  const flags: string[] = [];
  const options: CliOption[] = [];
  const commands: CliCommand[] = [];

  const lines = help.split("\n");

  // ── Parse options ───────────────────────────────────────────
  // Handles: --flag, -s/--flag, --aliasA/--aliasB, optional [args], required <args>
  const optionRegex = /^\s+(?:(-\w),\s+)?(?:--[\w-]+,\s+)?(--[\w-]+)(?:\s+(?:(<[^>]+>)|(\[[^\]]+\])))?\s{2,}(.+)$/;
  for (const line of lines) {
    const m = line.match(optionRegex);
    if (m) {
      const flag = m[2];
      const argName = m[3] || m[4] || undefined;
      const description = m[5].trim();
      options.push({ flag, argName, description });
      if (!flags.includes(flag)) flags.push(flag);
      if (m[1]) {
        const short = m[1].trim();
        if (short && !flags.includes(short)) flags.push(short);
      }
    }
  }

  // If structured parsing found nothing, fall back to regex extraction
  if (options.length === 0) {
    const flagMatches = help.match(/--[\w-]+/g);
    if (flagMatches) {
      for (const f of new Set(flagMatches)) {
        flags.push(f);
      }
    }
  }

  // ── Parse commands ──────────────────────────────────────────
  // Commands section looks like:
  // Commands:
  //   agents [options]                                  List configured agents
  //   auth                                              Manage authentication
  //   help [command]                                    display help for command
  let inCommandsSection = false;
  // Handles: name, name|alias, name [options]
  const commandRegex = /^\s{2,}([\w-]+)(?:\|[\w-]+)?(?:\s+\[[\w.]+\])?\s{2,}(.+)$/;
  for (const line of lines) {
    if (/^\s*Commands:\s*$/i.test(line)) {
      inCommandsSection = true;
      continue;
    }
    // Exit commands section on blank line or next section header
    if (inCommandsSection) {
      if (line.trim() === "" || (/^\S/.test(line) && !line.startsWith(" "))) {
        inCommandsSection = false;
        continue;
      }
      const cm = line.match(commandRegex);
      if (cm) {
        commands.push({ name: cm[1], description: cm[2].trim() });
      }
    }
  }

  // ── Look for model names ────────────────────────────────────
  const modelPatterns = ["opus", "sonnet", "haiku"];
  for (const m of modelPatterns) {
    if (help.toLowerCase().includes(m)) {
      models.push(m);
    }
  }

  // ── Look for permission modes ───────────────────────────────
  const permPatterns = ["acceptEdits", "bypassPermissions", "dontAsk", "plan"];
  for (const p of permPatterns) {
    if (help.includes(p)) {
      permissionModes.push(p);
    }
  }

  // Add subcommands not listed in --help but documented on claude.com
  const knownExtra = [
    { name: "remote-control", description: "Connect local environment to claude.ai/code" },
    { name: "install", description: "Install Claude Code native build" },
  ];
  for (const h of knownExtra) {
    if (!commands.some((c) => c.name === h.name)) {
      commands.push(h);
    }
  }

  return { models, permissionModes, flags, options, commands };
}
