import mascotSrc from "../../assets/claude-mascot.png";

export type MascotState = "reading" | "writing" | "moving" | "idle";

interface ClaudeMascotProps {
  state: MascotState;
  isSubagent?: boolean;
  size?: number;
}

const OVERLAY: Record<MascotState, string | null> = {
  reading: "\uD83D\uDC41",  // eye
  writing: "\u270F",         // pencil
  moving: null,
  idle: null,
};

export function ClaudeMascot({ state, isSubagent, size = 20 }: ClaudeMascotProps) {
  const overlay = OVERLAY[state];

  return (
    <span
      className={`claude-mascot claude-mascot-${state}${isSubagent ? " claude-mascot-subagent" : ""}`}
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
