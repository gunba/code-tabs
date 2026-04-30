import claudeMascot from "../../assets/claude-mascot.png";
import codexMascot from "../../assets/codex-mascot.png";
import { AgentTypeIcon } from "../AgentTypeIcon/AgentTypeIcon";

export type MascotState = "reading" | "writing" | "moving" | "idle" | "searching";

interface AgentMascotProps {
  state: MascotState;
  cli: "claude" | "codex";
  isSubagent?: boolean;
  /** When isSubagent is true, the subagent's type drives the icon choice. */
  subagentType?: string | null;
  isCompleted?: boolean;
  size?: number;
  /** Suppress the bottom-right overlay glyph. Used in the header where narration text already conveys state. */
  hideOverlay?: boolean;
}

const OVERLAY: Record<MascotState, string | null> = {
  reading: "\uD83D\uDC41",  // eye
  writing: "\u270F",         // pencil
  searching: "\uD83D\uDD0D", // magnifying glass
  moving: null,
  idle: null,
};

const MASCOT_SRC: Record<"claude" | "codex", string> = {
  claude: claudeMascot,
  codex: codexMascot,
};

// Subagents render as the same Lucide-style icon as the subagent card; main
// agents render the provider mascot artwork. Both share the .agent-mascot-img
// class so the rock / hop / bob animations apply identically.
export function AgentMascot({ state, cli, isSubagent, subagentType, isCompleted, size = 20, hideOverlay }: AgentMascotProps) {
  const overlay = hideOverlay ? null : OVERLAY[state];
  // [AP-04] Completed subagents reuse the same mascot with a dimmed, no-animation class.
  const classes = `agent-mascot agent-mascot-${state} agent-mascot-cli-${cli}${isSubagent ? " agent-mascot-subagent" : ""}${isCompleted ? " agent-mascot-completed" : ""}`;

  return (
    <span
      className={classes}
      style={{ width: size, height: size }}
    >
      {isSubagent ? (
        <span
          className="agent-mascot-img agent-mascot-icon"
          style={{ width: size, height: size }}
        >
          <AgentTypeIcon type={subagentType ?? null} size={size} />
        </span>
      ) : (
        <img
          className="agent-mascot-img"
          src={MASCOT_SRC[cli]}
          alt=""
          width={size}
          height={size}
          draggable={false}
        />
      )}
      {overlay && <span className="agent-mascot-overlay">{overlay}</span>}
    </span>
  );
}
