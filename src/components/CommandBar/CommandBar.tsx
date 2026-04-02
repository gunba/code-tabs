import { useCallback, useMemo } from "react";
import { writeToPty } from "../../lib/ptyRegistry";
import { useSettingsStore } from "../../store/settings";
import { useSessionStore } from "../../store/sessions";
import { computeHeatLevel, heatClassName } from "../../lib/claude";
import "./CommandBar.css";

// ── Component ───────────────────────────────────────────────────────

interface CommandBarProps {
  sessionId: string | null;
  sessionState: string;
  ctrlHeld: boolean;
}

type MergedEntry =
  | { kind: "command"; label: string; key: string; ts: number }
  | { kind: "skill"; label: string; key: string; ts: number; success: boolean };

export function CommandBar({ sessionId, sessionState, ctrlHeld }: CommandBarProps) {
  const slashCommands = useSettingsStore((s) => s.slashCommands);
  const commandUsage = useSettingsStore((s) => s.commandUsage);
  const expanded = useSettingsStore((s) => s.commandBarExpanded);
  const setExpanded = useSettingsStore((s) => s.setCommandBarExpanded);
  const history = useSessionStore((s) => sessionId ? s.commandHistory.get(sessionId) : undefined) ?? [];
  const skillInvocations = useSessionStore((s) => sessionId ? s.skillInvocations.get(sessionId) : undefined) ?? [];

  /** Send a slash command immediately. History recorded via PTY input and tap events. */
  const sendCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      writeToPty(sessionId, command + "\r");
    },
    [sessionId]
  );

  /** Type a command into the terminal without sending (no Enter). */
  const typeCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      writeToPty(sessionId, command);
    },
    [sessionId]
  );

  // [CB-01] Sort pills by usage frequency desc, then alphabetical
  const sortedCommands = useMemo(() => {
    return [...slashCommands].sort((a, b) => {
      const aCount = commandUsage[a.cmd] || 0;
      const bCount = commandUsage[b.cmd] || 0;
      if (aCount !== bCount) return bCount - aCount;
      return a.cmd.localeCompare(b.cmd);
    });
  }, [slashCommands, commandUsage]);

  const maxCount = useMemo(() => {
    if (sortedCommands.length === 0) return 0;
    return Math.max(...sortedCommands.map((c) => commandUsage[c.cmd] || 0), 0);
  }, [sortedCommands, commandUsage]);

  const handleClick = useCallback(
    (command: string, e: React.MouseEvent) => {
      if (!sessionId) return;

      if (e.ctrlKey) {
        // [CB-05] Ctrl+Click sends command to PTY immediately
        sendCommand(command);
      } else {
        // [CB-04] Normal click types command into terminal without sending
        typeCommand(command);
      }
    },
    [sessionId, sendCommand, typeCommand]
  );

  // Merge command history and skill invocations into a single time-ordered strip
  const merged = useMemo<MergedEntry[]>(() => {
    const entries: MergedEntry[] = [
      ...history.map((h) => ({
        kind: "command" as const,
        label: h.cmd,
        key: `cmd-${h.ts}-${h.cmd}`,
        ts: h.ts,
      })),
      ...skillInvocations.map((sk) => ({
        kind: "skill" as const,
        label: `/${sk.skill}`,
        key: sk.id,
        ts: sk.timestamp,
        success: sk.success,
      })),
    ];
    entries.sort((a, b) => b.ts - a.ts);
    return entries;
  }, [history, skillInvocations]);

  // Don't render if there's no active session
  if (!sessionId || sessionState === "dead") return null;

  const discovering = slashCommands.length === 0;

  return (
    <div className="command-bar">
      {/* [CB-11] Toggle chevron shows/hides slash-command grid only (not history) */}
      <div className="command-bar-collapse" onClick={() => setExpanded(!expanded)}>
        <span className="command-bar-chevron">{expanded ? "\u25BC" : "\u25B3"}</span>
      </div>
      {/* Slash commands grid: only when expanded */}
      {expanded && (
        <div className="command-bar-scroll">
          {discovering ? (
            <span className="command-bar-discovering">Discovering commands...</span>
          ) : (
            sortedCommands.map((cmd) => {
              const usageCount = commandUsage[cmd.cmd] || 0;
              const heatClass = heatClassName(computeHeatLevel(usageCount, maxCount));
              return (
                <button
                  key={cmd.cmd}
                  className={`command-btn${heatClass ? ` ${heatClass}` : ""}`}
                  onClick={(e) => handleClick(cmd.cmd, e)}
                  title={ctrlHeld ? `Ctrl+Click: Send "${cmd.cmd}"` : `Click: Type "${cmd.cmd}" into terminal\n${cmd.desc}`}
                  type="button"
                >
                  {cmd.cmd}
                </button>
              );
            })
          )}
        </div>
      )}
      {/* [CB-09] Per-session command history strip: newest left, merged with skill invocations */}
      {merged.length > 0 && (
        <div className="command-history">
          {merged.map((entry) => (
            <button
              key={entry.key}
              className={`command-history-item${entry.kind === "skill" ? ` skill-history-item${!entry.success ? " skill-failed" : ""}` : ""}`}
              onClick={() => sendCommand(entry.label)}
              title={`Re-send ${entry.label}`}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
