import type { SVGProps } from "react";

// [DF-08] Icons module: inline SVG components (stroke-based, 16x16, currentColor, pointerEvents none)
interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Icon({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Diagonal pencil — rename, accept edits */
export function IconPencil(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.5 2.5l2 2-8.5 8.5-3 1 1-3z" />
      <path d="M9.5 4.5l2 2" />
    </Icon>
  );
}

/** Filled rounded square — kill/stop */
export function IconStop(props: IconProps) {
  return (
    <Icon {...props} stroke="none" fill="currentColor">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </Icon>
  );
}

/** Two crossing diagonals — close */
export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

/** Curved left-down arrow — resume */
export function IconReturn(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v6a2 2 0 01-2 2H5" />
      <path d="M7 8l-3 3 3 3" />
    </Icon>
  );
}

/** 6-tooth cogwheel + center circle — config/settings */
export function IconGear(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M7 1.5h2l.4 1.5a5 5 0 011.5.9l1.4-.6 1 1.7-1.1 1a5 5 0 010 1.8l1.1 1-1 1.7-1.4-.6a5 5 0 01-1.5.9L9 14.5H7l-.4-1.5a5 5 0 01-1.5-.9l-1.4.6-1-1.7 1.1-1a5 5 0 010-1.8l-1.1-1 1-1.7 1.4.6a5 5 0 011.5-.9z" />
    </Icon>
  );
}

/** Right chevron with shaft — subagent indicator */
export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8h10M10 4.5L13.5 8 10 11.5" />
    </Icon>
  );
}

/** Page with folded corner + lines — document/CLAUDE.md */
export function IconDocument(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 1.5h5.5L13 5v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-13a1 1 0 011-1z" />
      <path d="M9.5 1.5V5H13" />
      <path d="M5.5 8.5h5M5.5 11h3" />
    </Icon>
  );
}

/** Anchor shape — hooks */
export function IconHook(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="4" r="1.5" />
      <path d="M8 5.5v5a3 3 0 003 3 3 3 0 003-3" />
      <path d="M5.5 8H8M8 8h2.5" />
    </Icon>
  );
}

/** Single puzzle piece — plugins */
export function IconPuzzle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 2.5a1.5 1.5 0 013 0V4h1a1 1 0 011 1v2.5h-1.5a1.5 1.5 0 000 3H14V13a1 1 0 01-1 1h-2.5v-1.5a1.5 1.5 0 00-3 0V14H5a1 1 0 01-1-1v-2.5h1.5a1.5 1.5 0 000-3H4V5a1 1 0 011-1h2.5V2.5a1.5 1.5 0 013 0z" />
    </Icon>
  );
}

/** Rounded rect + two dot eyes — bot/agents */
export function IconBot(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="5" width="11" height="8" rx="2" />
      <circle cx="6" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9" r="1" fill="currentColor" stroke="none" />
      <path d="M8 2v3" />
      <circle cx="8" cy="1.5" r="1" />
    </Icon>
  );
}

/** Left-filled semicircle — context usage */
export function IconHalfCircle(props: IconProps) {
  return (
    <Icon {...props} stroke="none">
      <path d="M8 2a6 6 0 000 12V2z" fill="currentColor" />
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </Icon>
  );
}

/** Small filled rotated square — token count */
export function IconDiamond(props: IconProps) {
  return (
    <Icon {...props} stroke="none" fill="currentColor">
      <rect x="5" y="5" width="6" height="6" rx="0.5" transform="rotate(45 8 8)" />
    </Icon>
  );
}

/** Circle + two hands — duration/clock */
export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Icon>
  );
}

/** Circle + diagonal slash — budget cap */
export function IconBudget(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.5 12.5l9-9" />
    </Icon>
  );
}

/** Triangle + exclamation — warning/dangerous */
export function IconWarning(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2L1.5 13.5h13z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Zigzag bolt — bypass permissions, effort */
export function IconLightning(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor">
      <path d="M9 1.5L4 9h4l-1 5.5L12 7H8z" />
    </Icon>
  );
}

/** Open padlock — don't ask */
export function IconUnlock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
      <path d="M5.5 7V4.5a2.5 2.5 0 015 0" />
    </Icon>
  );
}

/** Clipboard + clip — plan mode */
export function IconClipboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3.5" width="10" height="11" rx="1.5" />
      <path d="M6 3.5V2.5a1 1 0 011-1h2a1 1 0 011 1v1" />
      <path d="M5.5 7.5h5M5.5 10h3" />
    </Icon>
  );
}

/** Open folder — browse buttons */
export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4.5v8a1 1 0 001 1h10a1 1 0 001-1v-6a1 1 0 00-1-1H8L6.5 3.5H3a1 1 0 00-1 1z" />
    </Icon>
  );
}

/** Outlined diamond (hollow) — model selector */
export function IconModelDiamond(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1" transform="rotate(45 8 8)" />
    </Icon>
  );
}

/** Closed padlock — permissions selector */
export function IconLock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
      <path d="M5.5 7V4.5a2.5 2.5 0 015 0V7" />
    </Icon>
  );
}

/** Small filled circle — session count */
export function IconCircleFilled(props: IconProps) {
  return (
    <Icon {...props} stroke="none" fill="currentColor">
      <circle cx="8" cy="8" r="4" />
    </Icon>
  );
}

/** Hollow circle — inspector off */
export function IconCircleOutline(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5" />
    </Icon>
  );
}

/** Git branch fork — version control */
export function IconGitBranch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="6" r="1.5" />
      <path d="M5 5.5v5M5 8c0-2 6-2 6-2" />
    </Icon>
  );
}

/** Forward slash in rounded rect — skills/slash commands */
export function IconSkill(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M10 4L6 12" />
    </Icon>
  );
}

/** Head-and-shoulders silhouette — user scope */
export function IconUser(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 14.5c0-3 2.2-5 5-5s5 2 5 5" />
    </Icon>
  );
}

/** Curly brackets { } — project scope */
export function IconBraces(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 2.5c-1.5 0-2 1-2 2v2c0 .5-.5 1-1 1 .5 0 1 .5 1 1v2c0 1 .5 2 2 2" />
      <path d="M10.5 2.5c1.5 0 2 1 2 2v2c0 .5.5 1 1 1-.5 0-1 .5-1 1v2c0 1-.5 2-2 2" />
    </Icon>
  );
}

/** Terminal prompt >_ — local scope */
export function IconTerminal(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5l2.5 2-2.5 2" />
      <path d="M8.5 10.5h3" />
    </Icon>
  );
}

/** Magnifying glass — search */
export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4" />
      <line x1="10" y1="10" x2="14" y2="14" />
    </Icon>
  );
}

/** Counterclockwise circular arrow — reset */
export function IconReset(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 2.5v3.5H8" />
      <path d="M4.5 6A5 5 0 1113 8" />
    </Icon>
  );
}

/** Skull — dangerously skip permissions */
export function IconSkull(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9V6.5a4 4 0 018 0V9" />
      <path d="M4 9a1 1 0 001 1h1l.5 2.5h3L10 10h1a1 1 0 001-1" />
      <circle cx="6.5" cy="6.5" r="1.2" />
      <circle cx="9.5" cy="6.5" r="1.2" />
      <path d="M7 12.5v1M9 12.5v1" />
    </Icon>
  );
}

/** Simplified bulldozer — sandbox / project-dir restriction */
export function IconBulldozer(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 8.5h3V6h-1l-2 2.5z" />
      <rect x="5" y="5.5" width="7" height="4" rx="1" />
      <path d="M9 4h2.5a1 1 0 011 1v.5" />
      <path d="M3.5 12h10" />
      <circle cx="5.5" cy="12" r="1.5" />
      <circle cx="11.5" cy="12" r="1.5" />
    </Icon>
  );
}

/** Radio antenna with signal arcs — TAP recording */
export function IconAntenna(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 7v7" />
      <path d="M6 14h4" />
      <path d="M5.5 5.5a3.5 3.5 0 015 0" />
      <path d="M3.5 3.5a6.5 6.5 0 019 0" />
      <circle cx="8" cy="7" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Traffic light — API traffic logging */
export function IconTraffic(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="1.5" width="6" height="13" rx="1.5" />
      <circle cx="8" cy="4.5" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="8" cy="11.5" r="1.2" />
    </Icon>
  );
}
