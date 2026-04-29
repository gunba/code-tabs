import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { trace, traceAsync } from "../lib/perfTrace";
import { dlog } from "../lib/debugLog";
import type { CliCapabilities, CliOption, CliCommand } from "../store/settings";

/**
 * On app start, checks each installed agent CLI independently and parses the
 * capabilities exposed by that binary's current `--help` output.
 */
// [PR-01] useCliWatcher: checkClaude/checkCodex parallel; Codex normalizes capabilities from help+discover_codex_models+discover_codex_cli_options; single-run after session init
export function useCliWatcher(): void {
  const checkedRef = useRef(false);
  const initialized = useSessionStore((s) => s.initialized);

  useEffect(() => {
    if (checkedRef.current || !initialized) return;
    checkedRef.current = true;
    void check();

    async function check() {
      trace("cliWatcher: check start");
      dlog("discovery", null, "CLI watcher started", "LOG", {
        event: "discovery.cli_watcher_started",
        data: {},
      });

      await Promise.allSettled([checkClaude(), checkCodex()]);
    }

    async function checkClaude() {
      try {
        trace("cliWatcher: check start");
        const version = await traceAsync("cliWatcher: check_cli_version", () =>
          invoke<string>("check_cli_version")
        , {
          module: "discovery",
          event: "discovery.cli_version_perf",
          warnAboveMs: 500,
          data: { cli: "claude" },
        });
        const cached = useSettingsStore.getState().cliVersions.claude;
        dlog("discovery", null, "CLI version resolved", "LOG", {
          event: "discovery.cli_version_loaded",
          data: {
            cli: "claude",
            version,
            previousVersion: cached,
          },
        });

        // Always re-parse on startup — the help text is fast to parse
        // and we need fresh data when new flags are added to the CLI.
        if (version) {
          // Version changed — parse help for capabilities
          try {
            const help = await traceAsync("cliWatcher: get_cli_help", () =>
              invoke<string>("get_cli_help")
            , {
              module: "discovery",
              event: "discovery.cli_help_perf",
              warnAboveMs: 500,
              data: { cli: "claude", version },
            });
            const capabilities = parseHelpText(help);
            useSettingsStore.getState().setCliCapabilitiesForCli("claude", version, capabilities);
            dlog("discovery", null, "CLI help parsed into capabilities", "LOG", {
              event: "discovery.cli_capabilities_loaded",
              data: {
                cli: "claude",
                version,
                helpLength: help.length,
                models: capabilities.models,
                permissionModes: capabilities.permissionModes,
                flagCount: capabilities.flags.length,
                optionCount: capabilities.options.length,
                commandCount: capabilities.commands.length,
              },
            });
          } catch {
            // Help failed but version succeeded — update version without wiping last known capabilities.
            const previousCapabilities = useSettingsStore.getState().cliCapabilitiesByCli.claude;
            useSettingsStore.getState().setCliCapabilitiesForCli("claude", version, previousCapabilities);
            dlog("discovery", null, "CLI help parsing failed; preserved existing capabilities", "WARN", {
              event: "discovery.cli_capabilities_failed",
              data: { cli: "claude", version },
            });
          }

          // Discover settings schema from binary (runs in background, non-blocking)
          useSettingsStore.getState().loadBinarySettingsFieldsForCli("claude");

          // Discover env vars from binary catalog + process.env scan (runs in background, non-blocking)
          useSettingsStore.getState().loadKnownEnvVarsForCli("claude");

          // Fetch JSON Schema from schemastore (runs in background, non-blocking)
          useSettingsStore.getState().loadSettingsSchemaForCli("claude");

          // Log version change
          if (cached) {
            dlog("config", null, `Claude CLI updated: ${cached} → ${version}`);
          }
        }
      } catch (err) {
        useSettingsStore.getState().setCliCapabilitiesForCli("claude", null, emptyCapabilities());
        // CLI not found or version check failed — valid when the user only uses Codex.
        dlog("discovery", null, `Claude CLI watcher failed: ${err}`, "DEBUG", {
          event: "discovery.cli_watcher_failed",
          data: { cli: "claude", error: String(err) },
        });
      }
    }

    async function checkCodex() {
      try {
        const version = await traceAsync("cliWatcher: check_codex_cli_version", () =>
          invoke<string>("check_codex_cli_version")
        , {
          module: "discovery",
          event: "discovery.cli_version_perf",
          warnAboveMs: 500,
          data: { cli: "codex" },
        });
        const cached = useSettingsStore.getState().cliVersions.codex;
        let capabilities = emptyCapabilities();
        try {
          const [help, models, codexOptions] = await Promise.all([
            traceAsync("cliWatcher: get_codex_cli_help", () =>
              invoke<string>("get_codex_cli_help")
            , {
              module: "discovery",
              event: "discovery.cli_help_perf",
              warnAboveMs: 500,
              data: { cli: "codex", version },
            }),
            invoke<Array<{ slug: string; displayName?: string | null }>>("discover_codex_models")
              .catch(() => []),
            invoke<Array<{ flag: string; short?: string; description: string; takesValue: boolean }>>("discover_codex_cli_options")
              .catch(() => []),
          ]);
          capabilities = normalizeCodexCapabilities(parseHelpText(help), models, codexOptions);
          useSettingsStore.getState().setCliCapabilitiesForCli("codex", version, capabilities);
          dlog("discovery", null, "Codex CLI help parsed into capabilities", "LOG", {
            event: "discovery.cli_capabilities_loaded",
            data: {
              cli: "codex",
              version,
              helpLength: help.length,
              models: capabilities.models,
              flagCount: capabilities.flags.length,
              optionCount: capabilities.options.length,
              commandCount: capabilities.commands.length,
            },
          });

          // [PR-02] Discover Codex settings schema (binary mine + runtime remote fetch) and env var catalog. Both run in background; failures degrade UI gracefully.
          useSettingsStore.getState().loadSettingsSchemaForCli("codex");
          useSettingsStore.getState().loadKnownEnvVarsForCli("codex");
        } catch (err) {
          const previousCapabilities = useSettingsStore.getState().cliCapabilitiesByCli.codex;
          useSettingsStore.getState().setCliCapabilitiesForCli("codex", version, previousCapabilities);
          dlog("discovery", null, `Codex capabilities failed: ${err}`, "WARN", {
            event: "discovery.cli_capabilities_failed",
            data: { cli: "codex", version, error: String(err) },
          });
        }
        if (cached) {
          dlog("config", null, `Codex CLI updated: ${cached} → ${version}`);
        }
      } catch (err) {
        useSettingsStore.getState().setCliCapabilitiesForCli("codex", null, emptyCapabilities());
        dlog("discovery", null, `Codex CLI watcher failed: ${err}`, "DEBUG", {
          event: "discovery.cli_watcher_failed",
          data: { cli: "codex", error: String(err) },
        });
      }
    }
  }, [initialized]);
}

function emptyCapabilities(): CliCapabilities {
  return { models: [], permissionModes: [], flags: [], options: [], commands: [] };
}

function normalizeCodexCapabilities(
  parsed: CliCapabilities,
  models: Array<{ slug: string; displayName?: string | null }>,
  codexOptions: Array<{ flag: string; short?: string; description: string; takesValue: boolean }>,
): CliCapabilities {
  const options = codexOptions.length > 0
    ? codexOptions.map((opt) => ({
        flag: opt.flag,
        argName: opt.takesValue ? "<value>" : undefined,
        description: opt.description,
      }))
    : parsed.options;
  const flags = new Set<string>(parsed.flags);
  for (const opt of codexOptions) {
    flags.add(opt.flag);
    if (opt.short) flags.add(opt.short);
  }
  return {
    ...parsed,
    models: models.map((m) => m.slug).filter(Boolean),
    flags: Array.from(flags),
    options,
  };
}

function parseHelpText(help: string): CliCapabilities {
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
  // Also extract full model IDs (e.g. claude-opus-4-6, claude-opus-4-6[1m])
  // from the --model flag description or anywhere in help text.
  const fullIdRegex = /claude-[\w]+-[\d]+-[\d]+(?:\[\d+m\])?/g;
  const fullIds = help.match(fullIdRegex);
  if (fullIds) {
    for (const id of new Set(fullIds)) {
      if (!models.includes(id)) models.push(id);
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
