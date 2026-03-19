import { useState, useEffect, useCallback, useMemo } from "react";
import { writeToPty } from "../../lib/ptyRegistry";
import { useSettingsStore } from "../../store/settings";
import { computeHeatLevel, getHeatStyle } from "../../lib/claude";
import "./CommandBar.css";

// ── Component ───────────────────────────────────────────────────────

interface CommandBarProps {
  sessionId: string | null;
  sessionState: string;
  shiftHeld: boolean;
}

export function CommandBar({ sessionId, sessionState, shiftHeld }: CommandBarProps) {
  const [queuedCommand, setQueuedCommand] = useState<string | null>(null);
  const slashCommands = useSettingsStore((s) => s.slashCommands);
  const commandUsage = useSettingsStore((s) => s.commandUsage);
  const recordCommandUsage = useSettingsStore((s) => s.recordCommandUsage);

  // Sort: frequently-used first (by count desc), then alphabetical
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

  // When session becomes idle and there is a queued command, fire it.
  // Delay slightly so Claude Code has time to render the prompt.
  useEffect(() => {
    if (!queuedCommand || !sessionId) return;
    if (sessionState === "idle") {
      const timer = setTimeout(() => {
        writeToPty(sessionId, queuedCommand + "\r");
        recordCommandUsage(queuedCommand);
        setQueuedCommand(null);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [sessionState, queuedCommand, sessionId, recordCommandUsage]);

  // Clear queue if session dies
  useEffect(() => {
    if (sessionState === "dead") {
      setQueuedCommand(null);
    }
  }, [sessionState]);

  const handleClick = useCallback(
    (command: string, e: React.MouseEvent) => {
      if (!sessionId) return;

      if (e.shiftKey) {
        // Shift+click: queue for auto-send when idle (for when Claude is busy)
        setQueuedCommand((prev) => {
          if (prev === command) return null; // Toggle off
          return command;
        });
      } else {
        // Normal click: send immediately
        writeToPty(sessionId, command + "\r");
        recordCommandUsage(command);
      }
    },
    [sessionId, recordCommandUsage]
  );

  // Don't render if there's no active session
  if (!sessionId || sessionState === "dead") return null;

  const discovering = slashCommands.length === 0;

  return (
    <div className="command-bar">
      <div className="command-bar-scroll">
        {discovering ? (
          <span className="command-bar-discovering">Discovering commands...</span>
        ) : (
          sortedCommands.map((cmd) => {
            const isQueued = queuedCommand === cmd.cmd;
            const usageCount = commandUsage[cmd.cmd] || 0;
            const heat = computeHeatLevel(usageCount, maxCount);
            return (
              <button
                key={cmd.cmd}
                className={
                  "command-btn" +
                  (isQueued ? " command-btn-queued" : "")
                }
                style={isQueued || shiftHeld ? undefined : getHeatStyle(heat)}
                onClick={(e) => handleClick(cmd.cmd, e)}
                title={shiftHeld ? `Shift+Click: Queue "${cmd.cmd}"` : cmd.desc}
                type="button"
              >
                {cmd.cmd}
              </button>
            );
          })
        )}
      </div>
      {queuedCommand && (
        <div className="command-bar-queue-indicator">
          <span className="command-bar-queue-dot" />
          {queuedCommand} queued
        </div>
      )}
    </div>
  );
}
