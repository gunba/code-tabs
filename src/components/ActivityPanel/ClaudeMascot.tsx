import mascotSrc from "../../assets/claude-mascot.png";

export type MascotState = "reading" | "writing" | "moving" | "idle";

interface ClaudeMascotProps {
  state: MascotState;
  isSubagent?: boolean;
  isCompleted?: boolean;
  size?: number;
}

const OVERLAY: Record<MascotState, string | null> = {
  reading: "\uD83D\uDC41",  // eye
  writing: "\u270F",         // pencil
  moving: null,
  idle: null,
};

export function ClaudeMascot({ state, isSubagent, isCompleted, size = 20 }: ClaudeMascotProps) {
  const overlay = OVERLAY[state];
  // [AP-04] Completed subagents reuse the same mascot with a dimmed, no-animation class.
  const classes = `claude-mascot claude-mascot-${state}${isSubagent ? " claude-mascot-subagent" : ""}${isCompleted ? " claude-mascot-completed" : ""}`;

  return (
    <span
      className={classes}
      style={{ width: size, height: size }}
    >
      <img
        className="claude-mascot-img"
        src={mascotSrc}
        alt=""
        width={size}
        height={size}
        draggable={false}
      />
      {overlay && <span className="claude-mascot-overlay">{overlay}</span>}
    </span>
  );
}
