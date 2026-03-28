import { useCallback, useMemo } from "react";
import { writeToPty } from "../../lib/ptyRegistry";
import { useSettingsStore } from "../../store/settings";
import { useSessionStore } from "../../store/sessions";
import { computeHeatLevel, getHeatStyle } from "../../lib/claude";
import "./CommandBar.css";

// ── Component ───────────────────────────────────────────────────────

interface CommandBarProps {
  sessionId: string | null;
  sessionState: string;
  ctrlHeld: boolean;
}

export function CommandBar({ sessionId, sessionState, ctrlHeld }: CommandBarProps) {
  const slashCommands = useSettingsStore((s) => s.slashCommands);
  const commandUsage = useSettingsStore((s) => s.commandUsage);
  const expanded = useSettingsStore((s) => s.commandBarExpanded);
  const setExpanded = useSettingsStore((s) => s.setCommandBarExpanded);
  const history = useSessionStore((s) => sessionId ? s.commandHistory.get(sessionId) : undefined) ?? [];

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

  const handleClick = useCallback(
    (command: string, e: React.MouseEvent) => {
      if (!sessionId) return;

      if (e.ctrlKey) {
        // Ctrl+Click: send immediately (type + Enter)
        sendCommand(command);
      } else {
        // Normal click: type into terminal without sending
        typeCommand(command);
      }
    },
    [sessionId, sendCommand, typeCommand]
  );

  // Don't render if there's no active session
  if (!sessionId || sessionState === "dead") return null;

  const discovering = slashCommands.length === 0;

  return (
    <div className="command-bar">
      <button
        className="command-bar-toggle"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? "Collapse command bar" : "Expand command bar"}
        type="button"
      >
        {expanded ? "\u25BE" : "\u25B8"}
      </button>
      {expanded && (
        <>
          {history.length > 0 && (
            <div className="command-history">
              {history.map((cmd, i) => (
                <button
                  key={`${i}-${cmd}`}
                  className="command-history-item"
                  onClick={() => sendCommand(cmd)}
                  title={`Re-send ${cmd}`}
                  type="button"
                >
                  {cmd}
                </button>
              ))}
            </div>
          )}
          <div className="command-bar-scroll">
            {discovering ? (
              <span className="command-bar-discovering">Discovering commands...</span>
            ) : (
              sortedCommands.map((cmd) => {
                const usageCount = commandUsage[cmd.cmd] || 0;
                const heat = computeHeatLevel(usageCount, maxCount);
                return (
                  <button
                    key={cmd.cmd}
                    className="command-btn"
                    style={ctrlHeld ? undefined : getHeatStyle(heat)}
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
        </>
      )}
    </div>
  );
}
