import { useCallback, useMemo } from "react";
import { writeToPty } from "../../lib/ptyRegistry";
import { useSettingsStore } from "../../store/settings";
import { useSessionStore } from "../../store/sessions";
import { computeHeatLevel, heatClassName } from "../../lib/claude";
import { IconSkill, IconClose } from "../Icons/Icons";
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
  const skillInvocations = useSessionStore((s) => sessionId ? s.skillInvocations.get(sessionId) : undefined) ?? [];
  const removeSkillInvocation = useSessionStore((s) => s.removeSkillInvocation);

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
      {/* Skill invocation pills — results from /skill runs */}
      {skillInvocations.length > 0 && (
        <div className="skill-pills-row">
          {skillInvocations.map((sk) => (
            <span
              key={sk.id}
              className={`skill-pill${sk.success ? "" : " skill-failed"}`}
              title={`/${sk.skill}${sk.allowedTools.length ? ` (${sk.allowedTools.join(", ")})` : ""}`}
            >
              <IconSkill size={12} className="skill-icon" />
              <span className="skill-name">{sk.skill}</span>
              <span
                className="subagent-close"
                onClick={() => sessionId && removeSkillInvocation(sessionId, sk.id)}
                title="Dismiss"
              ><IconClose size={12} /></span>
            </span>
          ))}
        </div>
      )}
      {/* Toggle: chevron to expand/collapse slash commands */}
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
      {/* Command history: below the expander with a separator */}
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
    </div>
  );
}
