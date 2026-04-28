export type Vehicle = "board" | "jetski" | "swim";

interface Props {
  vehicle: Vehicle;
  size: number;
}

// Tiny SVG glyphs that sit a hair below the mascot's feet and translate
// with it. Surfboards are a flat ellipse; jetskis are a chunkier hull
// with a small bow; swimmers ride invisible "swim" (a couple of ripples
// drawn directly on the mascot wrapper via CSS).
export function Vehicle({ vehicle, size }: Props) {
  if (vehicle === "swim") return null;

  const w = size + 4;
  const h = vehicle === "jetski" ? 5 : 3;

  if (vehicle === "board") {
    return (
      <svg
        className="header-activity-viz-vehicle"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="board-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#e9d6a8" />
            <stop offset="100%" stopColor="#c8a868" />
          </linearGradient>
        </defs>
        <ellipse
          cx={w / 2}
          cy={h / 2}
          rx={w / 2 - 0.5}
          ry={h / 2}
          fill="url(#board-grad)"
        />
      </svg>
    );
  }

  // jetski
  return (
    <svg
      className="header-activity-viz-vehicle"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="jetski-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5b9bd1" />
          <stop offset="100%" stopColor="#2c5b87" />
        </linearGradient>
      </defs>
      <path
        d={`M 1 ${h - 1} Q ${w * 0.15} 0.5 ${w - 2} 1 L ${w - 0.5} ${h - 1} Z`}
        fill="url(#jetski-grad)"
      />
    </svg>
  );
}

// Stable per-id vehicle assignment with a 50/30/20 split.
export function vehicleFor(id: string): Vehicle {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  const bucket = ((h % 10) + 10) % 10;
  if (bucket < 5) return "board";
  if (bucket < 8) return "swim";
  return "jetski";
}
