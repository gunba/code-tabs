import { useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import claudeMascotSrc from "../../assets/claude-mascot.png";
import codexMascotSrc from "../../assets/codex-mascot.png";
import { useSessionStore } from "../../store/sessions";
import { useWeatherStore } from "../../store/weather";
import { isSessionIdle, type Session, type SessionState } from "../../types/session";
import { sceneForCode, type WeatherScene } from "../../lib/weatherCodes";
import { AgentTypeIcon } from "../AgentTypeIcon/AgentTypeIcon";
import "./HeaderActivityViz.css";

// [HA-01] Pixel-art / "voxel" scene rendered between the tab strip and the
// right-hand action buttons. Sky, sun/clouds/weather, layered ocean, foam
// crest, textured beach, real Claude/Codex mascot sprites and rasterized
// AgentTypeIcon SVGs for subagents — all on one <canvas>, single rAF tick,
// no DOM nodes per particle. Pre-rendered atlases keep the per-frame work
// cheap (drawImage + a few hundred fillRects on a strip ~72px tall).

const MASCOT_PX = 22;
const SUBAGENT_PX = 14;
const MASCOT_HOVER_PX = 1.2;
const BEACH_PAD_PX = 4;
const BUBBLE_INTERVAL_MS = 320;
const BUBBLE_LIFE_MS = 1200;
const STORM_PERIOD_S = 7;
const STORM_FLASH_S = 0.12;
const STORM_BOLT_S = 0.18;
const BASE_INTENSITY = 0.18;
const INTENSITY_DECAY_RETAIN_PER_500MS = 0.7;

const SUBAGENT_TYPES = [
  "general-purpose",
  "Explore",
  "Plan",
  "claude-code-guide",
  "statusline-setup",
  "verification",
  "__fallback__",
] as const;
type SubagentTypeKey = (typeof SUBAGENT_TYPES)[number];

interface SlotData {
  id: string;
  cli: "claude" | "codex";
  isSubagent: boolean;
  isCompleted: boolean;
  state: SessionState;
  subagentType: string | null;
}

interface Slot extends SlotData {
  xPx: number;
  dir: 1 | -1;
  homeXPx: number;
  homeRow01: number;
  speedPxPerS: number;
  jitterSeed: number;
  diveT: number;
  bubbleAccumMs: number;
}

interface Bubble {
  xPx: number;
  yPx: number;
  ageMs: number;
  size: number;
}

interface Cloud {
  xPx: number;
  yPx: number;
  width: number;
  speedPxPerS: number;
  shape: number;
}

interface Flake {
  xPx: number;
  yPx: number;
  swaySeed: number;
  speedPxPerS: number;
  size: number;
}

interface Drop {
  seed: number;
  x0: number;
  y0: number;
  speedPxPerS: number;
  length: number;
}

interface ThemeProps {
  bgSurface: string;
  textMuted: string;
  textSecondary: string;
  cliClaude: string;
  cliCodex: string;
  error: string;
}

interface SpriteAtlas {
  claude: HTMLCanvasElement;
  claudeError: HTMLCanvasElement;
  codex: HTMLCanvasElement;
  codexError: HTMLCanvasElement;
  subagent: Map<SubagentTypeKey, HTMLCanvasElement>;
  ready: boolean;
}

export function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function makeSlotInit(id: string, beachW = 110) {
  const h = hash32(id);
  const r1 = (h % 1000) / 1000;
  const r2 = ((h >> 10) % 1000) / 1000;
  const r3 = ((h >> 20) % 1000) / 1000;
  const padded = Math.max(0, beachW - BEACH_PAD_PX * 2);
  return {
    homeXPx: BEACH_PAD_PX + r1 * padded,
    homeRow01: r2,
    speedPxPerS: 28 + r3 * 22,
    jitterSeed: r1 * Math.PI * 2,
  };
}

export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith("#") && (c.length === 7 || c.length === 4)) {
    let r: number;
    let g: number;
    let b: number;
    if (c.length === 7) {
      r = parseInt(c.slice(1, 3), 16);
      g = parseInt(c.slice(3, 5), 16);
      b = parseInt(c.slice(5, 7), 16);
    } else {
      r = parseInt(c[1] + c[1], 16);
      g = parseInt(c[2] + c[2], 16);
      b = parseInt(c[3] + c[3], 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
  }
  return c;
}

export function clampPx(xPx: number, max: number): number {
  if (xPx < 0) return 0;
  if (xPx > max) return max;
  return xPx;
}

function readThemeProps(): ThemeProps {
  const css = getComputedStyle(document.documentElement);
  const get = (n: string, fallback: string) => css.getPropertyValue(n).trim() || fallback;
  return {
    bgSurface: get("--bg-surface", "#1a1a1a"),
    textMuted: get("--text-muted", "#888888"),
    textSecondary: get("--text-secondary", "#aaaaaa"),
    cliClaude: get("--cli-claude", "#d4744a"),
    cliCodex: get("--cli-codex", "#39c5cf"),
    error: get("--error", "#d96666"),
  };
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeOffscreen(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  return c;
}

// Pixel-perfect tinted copy of a source image. Uses source-in to mask the tint
// to the image's opaque pixels, then multiply on top of the original to keep
// shading/edges. Result is a same-size canvas suitable for drawImage.
function tintImage(src: HTMLImageElement | HTMLCanvasElement, hex: string, mix: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const out = makeOffscreen(w, h);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.globalAlpha = mix;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return out;
}

function rasterizeMascot(img: HTMLImageElement, sizePx: number): HTMLCanvasElement {
  const c = makeOffscreen(sizePx, sizePx);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, sizePx, sizePx);
  return c;
}

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

async function buildSubagentSprite(typeKey: SubagentTypeKey, color: string, sizePx: number): Promise<HTMLCanvasElement> {
  const type = typeKey === "__fallback__" ? null : typeKey;
  const reactSvg = renderToStaticMarkup(<AgentTypeIcon type={type} size={sizePx} />);
  const tinted = reactSvg.replace(/currentColor/g, color);
  const img = await svgToImage(tinted);
  const c = makeOffscreen(sizePx, sizePx);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, sizePx, sizePx);
  return c;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function buildAtlas(theme: ThemeProps): Promise<SpriteAtlas> {
  const [claudeImg, codexImg] = await Promise.all([
    loadImage(claudeMascotSrc),
    loadImage(codexMascotSrc),
  ]);
  const claude = rasterizeMascot(claudeImg, MASCOT_PX);
  const codex = rasterizeMascot(codexImg, MASCOT_PX);
  const claudeError = tintImage(claude, theme.error, 0.65);
  const codexError = tintImage(codex, theme.error, 0.65);
  const subagent = new Map<SubagentTypeKey, HTMLCanvasElement>();
  await Promise.all(
    SUBAGENT_TYPES.map(async (key) => {
      const sprite = await buildSubagentSprite(key, theme.cliClaude, SUBAGENT_PX);
      subagent.set(key, sprite);
    }),
  );
  return { claude, claudeError, codex, codexError, subagent, ready: true };
}

function subagentKeyFor(type: string | null | undefined): SubagentTypeKey {
  if (!type) return "__fallback__";
  for (const key of SUBAGENT_TYPES) {
    if (key === type) return key;
  }
  return "__fallback__";
}

// ── Layout & rendering ────────────────────────────────────────────────────

interface Layout {
  beachW: number;
  beachShoreSlope: number; // px the beach top descends from left to right
  seaMeanY: number;
  waveAmpMaxPx: number;
  beachTopYAtZero: number;
  skyHorizonY: number;
}

function computeLayout(w: number, h: number): Layout {
  const beachW = Math.max(80, Math.min(160, Math.round(w * 0.11)));
  const seaMeanY = Math.round(h * 0.6);
  const waveAmpMaxPx = Math.max(5, Math.round(h * 0.13));
  // Gentle dune profile: 4 px raised inland, descending to meet the water
  // exactly at the wave's resting line. The visible "slope" disappears
  // (≈4 px over ~100 px) so the sand reads as flush with the sea.
  const beachShoreSlope = Math.max(3, Math.round(h * 0.05));
  return {
    beachW,
    beachShoreSlope,
    seaMeanY,
    waveAmpMaxPx,
    beachTopYAtZero: seaMeanY - beachShoreSlope,
    skyHorizonY: Math.round(h * 0.45),
  };
}

function computeWaveCrests(
  layout: Layout,
  w: number,
  t: number,
  intensity: number,
  out: Float32Array,
): void {
  const { beachW, seaMeanY, waveAmpMaxPx } = layout;
  const period1 = 110;
  const period2 = 47;
  const speed1 = 36;
  const speed2 = 22;
  const amp = waveAmpMaxPx * (0.45 + 0.55 * intensity);
  // Wave amplitude ramps from 0 at the shore to full amplitude over rampDist
  // px so the sea joins the beach without a hard step at x === beachW.
  const rampDist = Math.max(20, Math.round(waveAmpMaxPx * 3));
  for (let x = 0; x < w; x++) {
    if (x < beachW) {
      out[x] = seaMeanY;
      continue;
    }
    const phase1 = ((x / period1) - (t * speed1) / period1) * Math.PI * 2;
    const phase2 = ((x / period2) + (t * speed2) / period2) * Math.PI * 2;
    const ramp = Math.min(1, (x - beachW) / rampDist);
    const wave = (Math.sin(phase1) * amp + Math.sin(phase2) * amp * 0.22) * ramp;
    out[x] = seaMeanY + wave;
  }
}

// Day/night phase from local clock. Returns:
//   light    — 0 (night) … 1 (peak day)
//   twilight — 0..1 amount of dawn/dusk warm tint
//   isNight  — true when the moon should be drawn instead of the sun
function celestialPhase(date = new Date()): { light: number; twilight: number; isNight: boolean } {
  const h = date.getHours() + date.getMinutes() / 60;
  // Smooth daylight curve peaking at solar noon (12:00).
  const daylight = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
  // Twilight bumps at ~5:30am and ~6:30pm — narrow Gaussian-ish peaks.
  const dawn = Math.exp(-Math.pow((h - 5.5) / 0.9, 2));
  const dusk = Math.exp(-Math.pow((h - 18.5) / 0.9, 2));
  const twilight = Math.max(dawn, dusk);
  const isNight = h < 6 || h >= 19;
  return { light: daylight, twilight, isNight };
}

function drawSky(
  ctx: CanvasRenderingContext2D,
  scene: WeatherScene,
  w: number,
  h: number,
  theme: ThemeProps,
  phase: { light: number; twilight: number; isNight: boolean },
): void {
  ctx.fillStyle = theme.bgSurface;
  ctx.fillRect(0, 0, w, h);
  // Choose sky stops by weather, then darken/lighten by daylight.
  let topR: number;
  let topG: number;
  let topB: number;
  let midR: number;
  let midG: number;
  let midB: number;
  let topA = 0.55;
  let midA = 0.32;
  switch (scene) {
    case "clear":
      [topR, topG, topB] = [40, 60, 95];
      [midR, midG, midB] = [80, 110, 150];
      break;
    case "clouds":
      [topR, topG, topB] = [70, 80, 95];
      [midR, midG, midB] = [110, 120, 135];
      topA = 0.55;
      midA = 0.35;
      break;
    case "rain":
      [topR, topG, topB] = [60, 70, 95];
      [midR, midG, midB] = [100, 115, 145];
      topA = 0.65;
      midA = 0.45;
      break;
    case "storm":
      [topR, topG, topB] = [35, 35, 55];
      [midR, midG, midB] = [70, 75, 100];
      topA = 0.78;
      midA = 0.55;
      break;
    case "snow":
      [topR, topG, topB] = [85, 95, 115];
      [midR, midG, midB] = [140, 150, 170];
      topA = 0.5;
      midA = 0.35;
      break;
    case "fog":
      [topR, topG, topB] = [80, 85, 95];
      [midR, midG, midB] = [135, 140, 150];
      topA = 0.55;
      midA = 0.45;
      break;
  }
  // At night, push the sky toward deep navy. During day, lighten toward the
  // chosen stops. Twilight introduces an orange/pink horizon.
  const nightMix = 1 - phase.light;
  const nightTopR = 14;
  const nightTopG = 22;
  const nightTopB = 50;
  const finalTopR = Math.round(topR * (1 - nightMix * 0.7) + nightTopR * nightMix * 0.7);
  const finalTopG = Math.round(topG * (1 - nightMix * 0.7) + nightTopG * nightMix * 0.7);
  const finalTopB = Math.round(topB * (1 - nightMix * 0.5) + nightTopB * nightMix * 0.5);
  const finalMidR = Math.round(midR * (1 - nightMix * 0.6));
  const finalMidG = Math.round(midG * (1 - nightMix * 0.6));
  const finalMidB = Math.round(midB * (1 - nightMix * 0.4) + 30 * nightMix * 0.4);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${finalTopR}, ${finalTopG}, ${finalTopB}, ${topA})`);
  grad.addColorStop(0.7, `rgba(${finalMidR}, ${finalMidG}, ${finalMidB}, ${midA})`);
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Twilight horizon glow (warm orange/pink) — strongest at dawn/dusk only.
  if (phase.twilight > 0.01) {
    const a = phase.twilight * 0.35;
    const glow = ctx.createLinearGradient(0, h * 0.25, 0, h * 0.62);
    glow.addColorStop(0, `rgba(255, 150, 100, 0)`);
    glow.addColorStop(1, `rgba(255, 165, 110, ${a.toFixed(3)})`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  } else if (scene === "clear" && !phase.isNight) {
    // Soft warm horizon for clear daytime.
    const horizonGrad = ctx.createLinearGradient(0, h * 0.35, 0, h * 0.62);
    horizonGrad.addColorStop(0, "rgba(255, 200, 130, 0)");
    horizonGrad.addColorStop(1, "rgba(255, 195, 130, 0.18)");
    ctx.fillStyle = horizonGrad;
    ctx.fillRect(0, 0, w, h);
  }
}

function drawStars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  // Deterministic star field via mulberry32 — same dots every frame, twinkle
  // alpha modulated by sin(t + seed).
  const rng = mulberry32(0x51eed1ed);
  const starCount = Math.max(20, Math.round(w / 28));
  for (let i = 0; i < starCount; i++) {
    const x = Math.floor(rng() * w);
    const y = Math.floor(rng() * h * 0.5);
    const seed = rng() * Math.PI * 2;
    const twinkle = 0.55 + 0.45 * Math.sin(t * 1.6 + seed);
    const a = alpha * twinkle * (0.4 + rng() * 0.6);
    ctx.fillStyle = `rgba(255, 252, 220, ${a.toFixed(3)})`;
    ctx.fillRect(x, y, 1, 1);
    // Very occasional brighter star with a 1px halo.
    if (rng() < 0.08) {
      ctx.fillStyle = `rgba(255, 248, 200, ${(a * 0.45).toFixed(3)})`;
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x, y + 1, 1, 1);
    }
  }
}

function drawMoon(ctx: CanvasRenderingContext2D, w: number, _h: number, t: number): void {
  const cx = w - 32;
  const cy = 18;
  const radius = 8;
  // Outer halo, much fainter than the sun's.
  const halo = ctx.createRadialGradient(cx, cy, radius - 1, cx, cy, radius + 10);
  halo.addColorStop(0, "rgba(225, 232, 255, 0.32)");
  halo.addColorStop(1, "rgba(225, 232, 255, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(cx - radius - 10, cy - radius - 10, (radius + 10) * 2, (radius + 10) * 2);
  // Disc with subtle crater texture (waxing-gibbous shadow on the right edge).
  const disc = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, radius);
  disc.addColorStop(0, "#f5f3e3");
  disc.addColorStop(0.7, "#dcd4b0");
  disc.addColorStop(1, "#9c9477");
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  // Shadow crescent — gives the moon a phase rather than looking flat.
  ctx.fillStyle = "rgba(20, 25, 45, 0.45)";
  ctx.beginPath();
  ctx.arc(cx + 3, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  // Two small craters.
  ctx.fillStyle = "rgba(120, 110, 80, 0.35)";
  ctx.fillRect(cx - 3, cy - 1, 2, 2);
  ctx.fillRect(cx, cy + 2, 1, 1);
  void t;
}

function drawSun(ctx: CanvasRenderingContext2D, w: number, _h: number, t: number): void {
  const cx = w - 32;
  const cy = 18;
  const radius = 8;
  const pulse = 0.85 + 0.15 * Math.sin(t * 1.2);
  const rotation = t * 0.18;
  // Outer halo
  const halo = ctx.createRadialGradient(cx, cy, radius - 1, cx, cy, radius + 14);
  halo.addColorStop(0, "rgba(253, 218, 107, 0.55)");
  halo.addColorStop(1, "rgba(253, 218, 107, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(cx - radius - 14, cy - radius - 14, (radius + 14) * 2, (radius + 14) * 2);
  // Rays
  ctx.strokeStyle = `rgba(253, 218, 107, ${0.65 * pulse})`;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + rotation;
    const r1 = radius + 2;
    const r2 = radius + 6 + Math.sin(t * 1.6 + i) * 1.3;
    const x1 = cx + Math.cos(angle) * r1;
    const y1 = cy + Math.sin(angle) * r1;
    const x2 = cx + Math.cos(angle) * r2;
    const y2 = cy + Math.sin(angle) * r2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  // Disc
  const disc = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, radius);
  disc.addColorStop(0, "#fff5c9");
  disc.addColorStop(0.6, "#fbd86f");
  disc.addColorStop(1, "#e8a544");
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawClouds(
  ctx: CanvasRenderingContext2D,
  cloudsRef: { current: Cloud[] | null },
  w: number,
  h: number,
  dtSec: number,
  scene: WeatherScene,
): void {
  if (!cloudsRef.current) {
    const list: Cloud[] = [];
    const count = scene === "storm" ? 5 : 4;
    for (let i = 0; i < count; i++) {
      list.push({
        xPx: (i / count) * w,
        yPx: 4 + ((i * 7) % 14),
        width: 38 + (i % 3) * 22,
        speedPxPerS: 6 + (i % 4) * 2.5,
        shape: i % 3,
      });
    }
    cloudsRef.current = list;
  }
  const baseAlpha = scene === "storm" ? 0.7 : scene === "rain" ? 0.55 : 0.45;
  for (const cl of cloudsRef.current) {
    cl.xPx += cl.speedPxPerS * dtSec;
    if (cl.xPx > w + cl.width) cl.xPx = -cl.width;
    drawCloud(ctx, cl.xPx, cl.yPx, cl.width, baseAlpha, cl.shape, scene === "storm");
  }
  void h;
}

function drawCloud(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  alpha: number,
  shape: number,
  dark: boolean,
): void {
  const top = dark ? "rgba(180, 185, 200, " : "rgba(225, 232, 245, ";
  const bottom = dark ? "rgba(115, 120, 140, " : "rgba(180, 195, 215, ";
  const grad = ctx.createLinearGradient(0, y - 4, 0, y + 8);
  grad.addColorStop(0, top + alpha + ")");
  grad.addColorStop(1, bottom + alpha * 0.85 + ")");
  ctx.fillStyle = grad;
  // Three overlapping ellipses give a fluffy silhouette.
  const layouts = [
    [
      [0, 3, 0.32, 4],
      [0.32, 0, 0.42, 5.5],
      [0.62, 3, 0.38, 4],
    ],
    [
      [0.05, 2, 0.28, 3.5],
      [0.28, -1, 0.36, 5],
      [0.55, 2, 0.45, 4.5],
    ],
    [
      [0, 2, 0.36, 4],
      [0.3, 0, 0.42, 5],
      [0.65, 2, 0.36, 4.5],
    ],
  ];
  for (const seg of layouts[shape]) {
    const [dx, dy, rxRel, ry] = seg;
    ctx.beginPath();
    ctx.ellipse(x + dx * w + (rxRel * w) / 2, y + dy, (rxRel * w) / 2, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function darkenForNight(hex: string, nightMix: number): string {
  // Mixes a hex sea color toward deep navy so the ocean reads as dark at
  // night while still preserving the per-scene tint by day.
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  // Stronger pull on the red/green channels than blue keeps the shift cool.
  const tr = 6;
  const tg = 14;
  const tb = 34;
  const nr = Math.round(r * (1 - nightMix * 0.7) + tr * nightMix * 0.7);
  const ng = Math.round(g * (1 - nightMix * 0.7) + tg * nightMix * 0.7);
  const nb = Math.round(b * (1 - nightMix * 0.45) + tb * nightMix * 0.45);
  return `rgb(${nr}, ${ng}, ${nb})`;
}

function drawSea(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  crests: Float32Array,
  w: number,
  h: number,
  scene: WeatherScene,
  t: number,
  phase: { light: number; twilight: number; isNight: boolean },
): void {
  const { beachW } = layout;
  if (beachW >= w) return;
  const nightMix = 1 - phase.light;
  // Sea polygon (under-wave fill) with vertical gradient, darkened at night.
  const seaGrad = ctx.createLinearGradient(0, layout.seaMeanY - layout.waveAmpMaxPx, 0, h);
  let topHex: string;
  let midHex: string;
  let botHex: string;
  if (scene === "storm") {
    topHex = "#143845";
    midHex = "#0c2230";
    botHex = "#070f18";
  } else if (scene === "rain") {
    topHex = "#1f5763";
    midHex = "#0f3340";
    botHex = "#091e29";
  } else if (scene === "fog") {
    topHex = "#456870";
    midHex = "#2c4750";
    botHex = "#1a2c33";
  } else {
    topHex = "#2f8290";
    midHex = "#155060";
    botHex = "#06222e";
  }
  seaGrad.addColorStop(0, darkenForNight(topHex, nightMix));
  seaGrad.addColorStop(0.55, darkenForNight(midHex, nightMix));
  seaGrad.addColorStop(1, darkenForNight(botHex, nightMix));
  ctx.fillStyle = seaGrad;
  ctx.beginPath();
  ctx.moveTo(beachW, h + 1);
  for (let x = beachW; x < w; x++) {
    ctx.lineTo(x, crests[x]);
  }
  ctx.lineTo(w, h + 1);
  ctx.closePath();
  ctx.fill();

  // Bright crest band: 2px just under the wave top.
  ctx.fillStyle = scene === "storm" ? "rgba(70, 130, 150, 0.45)" : "rgba(110, 200, 220, 0.55)";
  for (let x = beachW; x < w; x++) {
    const y = Math.floor(crests[x]) + 1;
    if (y < h) ctx.fillRect(x, y, 1, 2);
  }

  // Sparkle highlights on the surface, deterministic by (xBucket, tBucket).
  if (scene === "clear" || scene === "clouds") {
    const tb = Math.floor(t * 2);
    ctx.fillStyle = "rgba(220, 240, 250, 0.55)";
    for (let x = beachW + 6; x < w; x += 18) {
      const seed = ((x * 31 + tb * 17) >>> 0) % 100;
      if (seed < 35) {
        const y = Math.floor(crests[x]) + 4 + (seed % 3);
        if (y < h) ctx.fillRect(x + (seed % 3), y, 1, 1);
      }
    }
  }

  // Foam line: a continuous white edge along the wave top, with broader,
  // slightly irregular foam patches on the leading face of each crest.
  // No isolated dot above the peak — that produced an obvious bead pattern.
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  for (let x = beachW; x < w; x++) {
    const y = Math.floor(crests[x]);
    if (y < 0 || y >= h) continue;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.fillStyle = "rgba(240, 250, 252, 0.55)";
  for (let x = beachW + 1; x < w; x++) {
    const y = Math.floor(crests[x]);
    if (y - 1 < 0 || y - 1 >= h) continue;
    // Foam thickens on the descending (leading) side of a crest, where waves
    // would actually break — gives the wave a direction of travel.
    const left = crests[Math.max(0, x - 1)];
    const next = crests[Math.min(w - 1, x + 3)];
    const breaking = crests[x] < left && next > crests[x] + 0.3;
    if (breaking) ctx.fillRect(x, y - 1, 1, 1);
  }
}

function drawBeach(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  beachTile: HTMLCanvasElement | null,
  decoTile: HTMLCanvasElement | null,
  w: number,
  h: number,
  intensity: number,
  t: number,
): void {
  const { beachW, beachTopYAtZero, beachShoreSlope, seaMeanY } = layout;
  if (!beachTile || !decoTile) return;
  // Sand fill: nearly-flat trapezoid (4 px dune rise on the left). The clip
  // path lets the sand tile repeat without bleeding into the sea.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, beachTopYAtZero);
  ctx.lineTo(beachW, beachTopYAtZero + beachShoreSlope);
  ctx.lineTo(beachW, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.clip();
  const tileH = beachTile.height;
  const tileW = beachTile.width;
  for (let x = 0; x < beachW + tileW; x += tileW) {
    for (let y = beachTopYAtZero - 4; y < h; y += tileH) {
      ctx.drawImage(beachTile, x, y);
    }
  }
  ctx.drawImage(decoTile, 0, 0);
  ctx.restore();

  // Damp-sand band just inside the shore — darker, wet, ~3 px tall.
  ctx.fillStyle = "rgba(80, 50, 25, 0.32)";
  ctx.fillRect(0, seaMeanY - 3, beachW, 3);

  // Foam wash: the edge where sea climbs the sand. We draw two animated
  // sine ripples that overlap, giving an organic frothy line instead of a
  // ruler-straight stripe.
  const washPhase = t * 1.8;
  const washAmp = 0.6 + intensity * 1.2;
  for (let x = 0; x < beachW; x++) {
    const local = x / Math.max(1, beachW);
    const s1 = Math.sin(x * 0.32 + washPhase) * washAmp;
    const s2 = Math.sin(x * 0.18 - washPhase * 0.7 + 1.4) * washAmp * 0.6;
    const baseY = beachTopYAtZero + local * beachShoreSlope;
    const yEdge = Math.round(baseY + s1 + s2);
    if (yEdge >= 0 && yEdge < h) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fillRect(x, yEdge, 1, 1);
    }
    if (yEdge - 1 >= 0 && yEdge - 1 < h) {
      const sparkle = ((x * 7 + Math.floor(t * 6)) >>> 0) % 5;
      if (sparkle === 0) {
        ctx.fillStyle = "rgba(220, 240, 250, 0.7)";
        ctx.fillRect(x, yEdge - 1, 1, 1);
      }
    }
  }
  void w;
}

function makeSandTile(width = 96, height = 56): HTMLCanvasElement {
  const c = makeOffscreen(width, height);
  const ctx = c.getContext("2d")!;
  // Vertical gradient: drier (lighter, warmer) at the top, damper deeper.
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "#e8c47a");
  grad.addColorStop(0.5, "#d2a55c");
  grad.addColorStop(1, "#a87d3f");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  // Grain layers: medium dark, dark spots, then highlight sparkles.
  const rng = mulberry32(0x42beac4);
  const total = width * height;
  for (let i = 0; i < total * 0.18; i++) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * height);
    ctx.fillStyle = "rgba(120, 80, 40, 0.45)";
    ctx.fillRect(x, y, 1, 1);
  }
  for (let i = 0; i < total * 0.06; i++) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * height);
    ctx.fillStyle = "rgba(70, 45, 25, 0.45)";
    ctx.fillRect(x, y, 1, 1);
  }
  for (let i = 0; i < total * 0.04; i++) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * height);
    ctx.fillStyle = "rgba(255, 240, 200, 0.55)";
    ctx.fillRect(x, y, 1, 1);
  }
  // Soft horizontal ripples (low-frequency wind-blown streaks).
  ctx.fillStyle = "rgba(80, 60, 30, 0.18)";
  for (let i = 0; i < 14; i++) {
    const y = Math.floor(rng() * height);
    const xStart = Math.floor(rng() * width);
    const len = 6 + Math.floor(rng() * 14);
    for (let dx = 0; dx < len; dx++) {
      ctx.fillRect((xStart + dx) % width, y, 1, 1);
    }
  }
  return c;
}

function makeBeachDecoTile(beachW: number, h: number, layout: Layout): HTMLCanvasElement {
  const c = makeOffscreen(beachW, h);
  const ctx = c.getContext("2d")!;
  // Reserve slots for the big landmarks (umbrella, towel, sandcastle) so they
  // don't collide. Each landmark gets a horizontal third of the beach.
  const minY = layout.beachTopYAtZero + 4;
  const maxY = h - 3;
  const landmarkY = h - 4;
  const sectionW = beachW / 3;

  // Umbrella + pole — leftmost section, anchored toward the back of the beach.
  const umbrellaCx = Math.round(sectionW * 0.55);
  drawUmbrella(ctx, umbrellaCx, layout.beachTopYAtZero + 1);

  // Beach towel — middle section.
  const towelX = Math.round(sectionW * 1.2);
  drawTowel(ctx, towelX, landmarkY - 1);

  // Sandcastle — rightmost section, near the water (but inland of foam).
  const castleX = Math.round(sectionW * 2.05);
  drawSandcastle(ctx, castleX, landmarkY - 1);

  // Smaller scattered ornaments fill in around the landmarks.
  const rng = mulberry32(0x9e3779b1);
  const decoCount = Math.max(3, Math.round(beachW / 22));
  for (let i = 0; i < decoCount; i++) {
    const x = Math.floor(rng() * (beachW - 6)) + 1;
    const y = minY + Math.floor(rng() * Math.max(1, maxY - minY));
    // Skip decorations that would overlap a landmark footprint.
    if (Math.abs(x - umbrellaCx) < 8 && y < layout.beachTopYAtZero + 18) continue;
    if (Math.abs(x - towelX) < 12 && y > landmarkY - 4) continue;
    if (Math.abs(x - castleX) < 10 && y > landmarkY - 7) continue;
    const kind = Math.floor(rng() * 5);
    drawDeco(ctx, x, y, kind, rng);
  }

  // Footprint trail meandering from the towel toward the sea.
  const trailRng = mulberry32(0xabcdef01);
  let fx = Math.round(sectionW * 1.5);
  let fy = h - 5;
  for (let s = 0; s < 4; s++) {
    drawFootprint(ctx, fx, fy, s % 2 === 0);
    fx += 5 + Math.floor(trailRng() * 4);
    fy -= 2 + Math.floor(trailRng() * 2);
    if (fx > beachW - 4 || fy < layout.beachTopYAtZero) break;
  }
  return c;
}

function drawUmbrella(ctx: CanvasRenderingContext2D, cx: number, topY: number): void {
  // Pole: dark vertical line.
  ctx.fillStyle = "#5b3a1c";
  ctx.fillRect(cx, topY + 1, 1, 16);
  // Canopy: red-and-white striped half-disc using horizontal slats.
  const stripes = ["#d44a3a", "#f4f1e6", "#d44a3a", "#f4f1e6", "#d44a3a"];
  // Wedge widths (radii) per row, top to bottom.
  const widths = [3, 5, 7, 9, 10];
  for (let i = 0; i < widths.length; i++) {
    ctx.fillStyle = stripes[i];
    ctx.fillRect(cx - widths[i], topY + i, widths[i] * 2 + 1, 1);
  }
  // Tip dot at the top of the canopy.
  ctx.fillStyle = "#b8362b";
  ctx.fillRect(cx, topY - 1, 1, 1);
  // Underside shadow.
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.fillRect(cx - widths[widths.length - 1] + 1, topY + widths.length, widths[widths.length - 1] * 2 - 1, 1);
}

function drawTowel(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // Striped beach towel: 14 px wide, 4 px tall, with cyan/yellow/red stripes.
  const w = 14;
  const stripes = ["#3aa1c0", "#f4d35a", "#d96666", "#5fb09a"];
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(x - 1, y + 1, w + 2, 1); // shadow under the towel
  for (let i = 0; i < w; i++) {
    const s = Math.floor((i / w) * stripes.length);
    ctx.fillStyle = stripes[Math.min(stripes.length - 1, s)];
    ctx.fillRect(x + i, y - 2, 1, 3);
  }
  // Fringe
  ctx.fillStyle = "#ece5cf";
  ctx.fillRect(x, y - 3, w, 1);
}

function drawSandcastle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // Three-tower castle silhouette in slightly-darker damp sand colour.
  const sand = "#b8893f";
  const sandLight = "#e0b878";
  const sandShadow = "#7d5828";
  // Base
  ctx.fillStyle = sand;
  ctx.fillRect(x, y, 12, 3);
  ctx.fillStyle = sandShadow;
  ctx.fillRect(x, y + 2, 12, 1);
  // Left tower
  ctx.fillStyle = sand;
  ctx.fillRect(x, y - 5, 3, 5);
  ctx.fillStyle = sandLight;
  ctx.fillRect(x, y - 5, 1, 5);
  // Right tower
  ctx.fillStyle = sand;
  ctx.fillRect(x + 9, y - 5, 3, 5);
  ctx.fillStyle = sandLight;
  ctx.fillRect(x + 9, y - 5, 1, 5);
  // Center keep
  ctx.fillStyle = sand;
  ctx.fillRect(x + 4, y - 7, 4, 7);
  ctx.fillStyle = sandLight;
  ctx.fillRect(x + 4, y - 7, 1, 7);
  // Crenellations on the towers
  ctx.fillStyle = sand;
  ctx.fillRect(x, y - 6, 1, 1);
  ctx.fillRect(x + 2, y - 6, 1, 1);
  ctx.fillRect(x + 9, y - 6, 1, 1);
  ctx.fillRect(x + 11, y - 6, 1, 1);
  ctx.fillRect(x + 4, y - 8, 1, 1);
  ctx.fillRect(x + 6, y - 8, 1, 1);
  // Tiny flag on the keep
  ctx.fillStyle = "#d44a3a";
  ctx.fillRect(x + 5, y - 9, 2, 1);
  ctx.fillStyle = sandShadow;
  ctx.fillRect(x + 5, y - 9, 1, 3);
}

function drawDeco(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: number,
  rng: () => number,
): void {
  switch (kind) {
    case 0: {
      // Pebble: small dark gray rounded rect.
      const tone = rng() < 0.5 ? "#5a5853" : "#807a6b";
      ctx.fillStyle = tone;
      ctx.fillRect(x, y, 3, 2);
      ctx.fillRect(x + 1, y - 1, 2, 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.fillRect(x + 1, y, 1, 1);
      break;
    }
    case 1: {
      // Twin shell halves.
      ctx.fillStyle = "#f3d2b3";
      ctx.fillRect(x, y, 4, 2);
      ctx.fillRect(x + 1, y - 1, 2, 1);
      ctx.fillStyle = "#bf8a64";
      ctx.fillRect(x, y + 1, 4, 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.fillRect(x + 1, y, 1, 1);
      break;
    }
    case 2: {
      // Spiral conch silhouette.
      ctx.fillStyle = "#e6b48b";
      ctx.fillRect(x, y, 4, 1);
      ctx.fillRect(x, y + 1, 5, 1);
      ctx.fillRect(x + 1, y + 2, 3, 1);
      ctx.fillStyle = "#a37148";
      ctx.fillRect(x + 4, y, 1, 1);
      ctx.fillStyle = "rgba(255, 230, 200, 0.55)";
      ctx.fillRect(x + 1, y, 1, 1);
      break;
    }
    case 3: {
      // Starfish dot (5 arms).
      ctx.fillStyle = "#d77b54";
      ctx.fillRect(x, y, 3, 3);
      ctx.fillRect(x - 1, y + 1, 5, 1);
      ctx.fillRect(x + 1, y - 1, 1, 1);
      ctx.fillRect(x + 1, y + 3, 1, 1);
      ctx.fillStyle = "#9c4d2d";
      ctx.fillRect(x + 1, y + 1, 1, 1);
      break;
    }
    default: {
      // Driftwood: short tan rectangle.
      ctx.fillStyle = "#8c6442";
      ctx.fillRect(x, y, 6, 1);
      ctx.fillStyle = "#5a3e22";
      ctx.fillRect(x, y + 1, 6, 1);
      break;
    }
  }
}

// Chaotic break/chop where the wave meets the beach. Produces an irregular
// band of foam pixels scattered around the shore line plus a few "splash"
// columns that briefly shoot up the beach. All driven by deterministic
// time-bucketed hashes so the noise looks organic but not random per frame.
function drawShoreChop(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  _w: number,
  h: number,
  t: number,
  intensity: number,
): void {
  const { beachW, beachTopYAtZero, beachShoreSlope, seaMeanY } = layout;
  if (beachW <= 0) return;
  const tBucket = Math.floor(t * 4);
  const tSubBucket = Math.floor(t * 8);
  const chopAmp = 1.5 + intensity * 2.4;
  const breakColumns = Math.max(2, Math.round(beachW / 18));

  // Foam splatter scattered around the shore line (across the entire beach
  // width and a few pixels into the water on the right side).
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  for (let x = 0; x < beachW + 14; x++) {
    const local = x / Math.max(1, beachW);
    const baseY = beachTopYAtZero + Math.min(1, local) * beachShoreSlope;
    const seed = (x * 47 + tSubBucket * 31) >>> 0;
    const noise = ((seed % 211) / 211) - 0.5;
    const y = Math.round(baseY + Math.sin(x * 0.55 + t * 4) * chopAmp + noise * chopAmp * 1.5);
    if (y >= 0 && y < h) {
      ctx.fillRect(x, y, 1, 1);
    }
    // A second, lighter band immediately above for spray.
    if (((seed >>> 5) % 6) === 0 && y - 1 >= 0 && y - 1 < h) {
      ctx.fillStyle = "rgba(225, 240, 250, 0.6)";
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    }
  }

  // Splash plumes: short vertical foam columns that fire occasionally at the
  // shore edge, the way a wave would crash and throw spray up the beach.
  for (let i = 0; i < breakColumns; i++) {
    const seed = (i * 1103515245 + tBucket * 12345) >>> 0;
    const phase = (seed % 9) - 1; // 0..7 step within the bucket
    if (phase < 0 || phase > 3) continue;
    const xPlume = Math.round(((seed >>> 8) % beachW));
    const lifeT = phase / 3; // 0..1 over four sub-buckets
    const heightPx = (3 + ((seed >>> 12) % 4)) * (1 - lifeT * 0.5);
    const baseY = beachTopYAtZero + (xPlume / Math.max(1, beachW)) * beachShoreSlope;
    for (let dy = 0; dy < heightPx; dy++) {
      const y = Math.round(baseY - dy);
      if (y < 0 || y >= h) continue;
      const a = (1 - dy / heightPx) * (1 - lifeT) * 0.85;
      ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      ctx.fillRect(xPlume + ((dy & 1) ? 1 : 0), y, 1, 1);
    }
    // Side spray
    const sideY = Math.round(baseY - heightPx + 1);
    if (sideY >= 0 && sideY < h) {
      const a = 0.55 * (1 - lifeT);
      ctx.fillStyle = `rgba(245, 250, 255, ${a.toFixed(3)})`;
      ctx.fillRect(xPlume - 2, sideY, 1, 1);
      ctx.fillRect(xPlume + 2, sideY, 1, 1);
    }
  }

  // Receding-wash dark stripe just inland — wet sand left by the chop.
  ctx.fillStyle = "rgba(60, 35, 18, 0.22)";
  for (let x = 0; x < beachW; x++) {
    const local = x / Math.max(1, beachW);
    const baseY = beachTopYAtZero + local * beachShoreSlope;
    const wobble = Math.sin(x * 0.35 - t * 1.6) * (chopAmp * 0.6);
    const y = Math.round(baseY + 1 + wobble);
    if (y >= 0 && y < h) ctx.fillRect(x, y, 1, 1);
  }
  void seaMeanY;
}

function drawFootprint(ctx: CanvasRenderingContext2D, x: number, y: number, left: boolean): void {
  ctx.fillStyle = "rgba(60, 35, 18, 0.32)";
  // Heel
  ctx.fillRect(x, y, 2, 1);
  // Arch
  ctx.fillRect(x + 1, y - 1, 2, 1);
  // Toe (offset by foot side)
  ctx.fillRect(x + (left ? 1 : 2), y - 2, 1, 1);
}

function drawRain(
  ctx: CanvasRenderingContext2D,
  drops: Drop[],
  w: number,
  h: number,
  t: number,
  heavy: boolean,
): void {
  ctx.strokeStyle = heavy ? "rgba(180, 200, 230, 0.85)" : "rgba(155, 194, 230, 0.65)";
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  for (const d of drops) {
    const cycle = (d.y0 + t * d.speedPxPerS) % (h + d.length + 4);
    const y = cycle - d.length - 2;
    const x = (d.x0 + (cycle * 0.18)) % w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 2.5, y + d.length);
    ctx.stroke();
  }
}

function drawSnow(
  ctx: CanvasRenderingContext2D,
  flakes: Flake[],
  w: number,
  h: number,
  dtSec: number,
  t: number,
): void {
  for (const f of flakes) {
    f.yPx += f.speedPxPerS * dtSec;
    if (f.yPx > h + 2) {
      f.yPx = -2;
      f.xPx = (f.xPx + 53.7) % w;
    }
    const dx = Math.sin(t * 0.55 + f.swaySeed) * 3;
    const x = Math.round(f.xPx + dx);
    const y = Math.round(f.yPx);
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    if (f.size >= 2) {
      ctx.fillStyle = "rgba(245, 250, 255, 0.95)";
      ctx.fillRect(x, y, 2, 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.fillRect(x + 2, y, 1, 1);
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x, y + 2, 1, 1);
    } else {
      ctx.fillStyle = "rgba(245, 250, 255, 0.85)";
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function drawFog(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  // Three drifting horizontal fog bands using soft alpha gradients.
  const bands = [
    { y: h * 0.35, height: 14, drift: t * 5, alpha: 0.18 },
    { y: h * 0.55, height: 10, drift: t * 7 + 50, alpha: 0.22 },
    { y: h * 0.72, height: 8, drift: t * 9 + 110, alpha: 0.16 },
  ];
  for (const b of bands) {
    const grad = ctx.createLinearGradient(-30, 0, w + 30, 0);
    const offset = ((b.drift % 80) + 80) % 80 / 80;
    grad.addColorStop(Math.max(0, offset - 0.25), "rgba(200, 210, 220, 0)");
    grad.addColorStop(offset, `rgba(220, 230, 240, ${b.alpha})`);
    grad.addColorStop(Math.min(1, offset + 0.25), "rgba(200, 210, 220, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, b.y - b.height / 2, w, b.height);
  }
}

function drawStormBolt(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
): void {
  const phase = t % STORM_PERIOD_S;
  if (phase >= STORM_BOLT_S) return;
  const seed = Math.floor(t / STORM_PERIOD_S);
  const rng = mulberry32(seed * 9301 + 49297);
  const startX = 60 + rng() * (w - 120);
  const baseAlpha = 1 - phase / STORM_BOLT_S;
  ctx.strokeStyle = `rgba(255, 240, 200, ${baseAlpha})`;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(255, 230, 170, 0.85)";
  ctx.shadowBlur = 6;
  ctx.beginPath();
  let x = startX;
  let y = 0;
  ctx.moveTo(x, y);
  while (y < h * 0.55) {
    y += 5 + rng() * 5;
    x += (rng() - 0.5) * 9;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawStormFlash(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
): void {
  const phase = t % STORM_PERIOD_S;
  if (phase >= STORM_FLASH_S) return;
  const a = 0.22 * (1 - phase / STORM_FLASH_S);
  ctx.fillStyle = `rgba(220, 230, 255, ${a.toFixed(3)})`;
  ctx.fillRect(0, 0, w, h);
}

// ── Component ─────────────────────────────────────────────────────────────

export function HeaderActivityViz() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slotsMapRef = useRef<Map<string, Slot>>(new Map());
  const bubblesRef = useRef<Bubble[]>([]);
  const cloudsRef = useRef<Cloud[] | null>(null);
  const flakesRef = useRef<Flake[] | null>(null);
  const dropsRef = useRef<Drop[] | null>(null);
  const intensityRef = useRef(BASE_INTENSITY);
  const themeRef = useRef<ThemeProps | null>(null);
  const sceneRef = useRef<WeatherScene>("clear");
  const atlasRef = useRef<SpriteAtlas | null>(null);
  const beachTileRef = useRef<HTMLCanvasElement | null>(null);
  const decoTileRef = useRef<HTMLCanvasElement | null>(null);
  const lastBeachWRef = useRef(0);
  const lastBeachHRef = useRef(0);

  const sessions = useSessionStore((s) => s.sessions);
  const subagents = useSessionStore((s) => s.subagents);
  const weatherCode = useWeatherStore((s) => s.weatherCode);

  const slots = useMemo<SlotData[]>(() => {
    const out: SlotData[] = [];
    for (const s of sessions) {
      if (s.state === "dead" || s.isMetaAgent) continue;
      out.push({
        id: s.id,
        cli: s.config.cli,
        isSubagent: false,
        isCompleted: false,
        state: s.state,
        subagentType: null,
      });
      const subs = subagents.get(s.id) || [];
      for (const sub of subs) {
        if (sub.state === "dead") continue;
        if (isSessionIdle(sub.state) && !sub.completed) continue;
        out.push({
          id: `${s.id}::${sub.id}`,
          cli: s.config.cli,
          isSubagent: true,
          isCompleted: !!sub.completed,
          state: sub.state,
          subagentType: sub.subagentType ?? null,
        });
      }
    }
    return out;
  }, [sessions, subagents]);

  useEffect(() => {
    sceneRef.current = sceneForCode(weatherCode);
    cloudsRef.current = null;
    flakesRef.current = null;
    dropsRef.current = null;
  }, [weatherCode]);

  useEffect(() => {
    const map = slotsMapRef.current;
    const seen = new Set<string>();
    for (const s of slots) {
      seen.add(s.id);
      const existing = map.get(s.id);
      if (existing) {
        existing.cli = s.cli;
        existing.isSubagent = s.isSubagent;
        existing.isCompleted = s.isCompleted;
        existing.state = s.state;
        existing.subagentType = s.subagentType;
      } else {
        const init = makeSlotInit(s.id, lastBeachWRef.current || 110);
        map.set(s.id, {
          ...s,
          xPx: init.homeXPx,
          dir: 1,
          homeXPx: init.homeXPx,
          homeRow01: init.homeRow01,
          speedPxPerS: init.speedPxPerS,
          jitterSeed: init.jitterSeed,
          diveT: 0,
          bubbleAccumMs: 0,
        });
      }
    }
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
  }, [slots]);

  useEffect(() => {
    const lastCounts = new Map<string, number>();
    const updateActivity = (latest: Session[]) => {
      let delta = 0;
      const present = new Set<string>();
      for (const s of latest) {
        present.add(s.id);
        const cur = s.metadata.toolCount ?? 0;
        const prev = lastCounts.get(s.id);
        if (prev === undefined) {
          lastCounts.set(s.id, cur);
          continue;
        }
        if (cur > prev) delta += cur - prev;
        lastCounts.set(s.id, cur);
      }
      for (const id of [...lastCounts.keys()]) if (!present.has(id)) lastCounts.delete(id);
      if (delta > 0) {
        const burst = 1 - Math.exp(-delta / 3);
        const target = BASE_INTENSITY + (1 - BASE_INTENSITY) * burst;
        intensityRef.current =
          intensityRef.current * INTENSITY_DECAY_RETAIN_PER_500MS +
          target * (1 - INTENSITY_DECAY_RETAIN_PER_500MS);
      }
    };
    updateActivity(useSessionStore.getState().sessions);
    return useSessionStore.subscribe((state, prevState) => {
      if (state.sessions === prevState.sessions) return;
      updateActivity(state.sessions);
    });
  }, []);

  const themeBumpRef = useRef(0);
  useEffect(() => {
    themeRef.current = readThemeProps();
    themeBumpRef.current++;
    const obs = new MutationObserver(() => {
      themeRef.current = readThemeProps();
      themeBumpRef.current++;
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => obs.disconnect();
  }, []);

  // Build the sprite atlas once theme is ready. Re-runs only when theme bumps
  // change colours that the error-tinted variants depend on.
  useEffect(() => {
    let cancelled = false;
    const theme = themeRef.current;
    if (!theme) return;
    buildAtlas(theme).then((atlas) => {
      if (!cancelled) atlasRef.current = atlas;
    });
    return () => {
      cancelled = true;
    };
  }, [themeBumpRef.current]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    let prevMs = 0;
    let prevDpr = 0;
    let prevW = 0;
    let prevH = 0;
    let needsResize = true;
    let lastThemeBump = -1;
    const waveCrests = { current: new Float32Array(2) };

    const ro = new ResizeObserver(() => {
      needsResize = true;
    });
    ro.observe(wrapper);

    const resize = () => {
      const rect = wrapper.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      if (w !== prevW || h !== prevH || dpr !== prevDpr) {
        prevW = w;
        prevH = h;
        prevDpr = dpr;
        canvas.width = Math.max(1, w * dpr);
        canvas.height = Math.max(1, h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;
        if (waveCrests.current.length < w + 1) {
          waveCrests.current = new Float32Array(w + 1);
        }
      }
    };

    const ensureBeachTiles = (layout: Layout, h: number) => {
      const beachW = layout.beachW;
      if (beachTileRef.current && lastBeachHRef.current === h) {
        // Sand tile is independent of beachW; only redo if h changed.
      } else {
        beachTileRef.current = makeSandTile(96, Math.max(48, h));
        lastBeachHRef.current = h;
      }
      if (!decoTileRef.current || lastBeachWRef.current !== beachW) {
        decoTileRef.current = makeBeachDecoTile(beachW, h, layout);
        lastBeachWRef.current = beachW;
      }
    };

    const ensureWeatherState = (scene: WeatherScene, w: number, h: number) => {
      if ((scene === "rain" || scene === "storm") && !dropsRef.current) {
        const drops: Drop[] = [];
        const count = Math.max(8, Math.round((w * h) / 600));
        for (let i = 0; i < count; i++) {
          const seed = i;
          drops.push({
            seed,
            x0: (i * 23.7) % w,
            y0: (i * 11.3) % h,
            speedPxPerS: 90 + (i % 7) * 8,
            length: scene === "storm" ? 8 : 6,
          });
        }
        dropsRef.current = drops;
      }
      if (scene === "snow" && !flakesRef.current) {
        const flakes: Flake[] = [];
        const count = Math.max(10, Math.round(w / 28));
        for (let i = 0; i < count; i++) {
          flakes.push({
            xPx: ((i * 47) % w),
            yPx: ((i * 13) % h) - 4,
            swaySeed: i * 1.7,
            speedPxPerS: 12 + (i % 5) * 3,
            size: i % 3 === 0 ? 2 : 1,
          });
        }
        flakesRef.current = flakes;
      }
    };

    const render = (timeMs: number) => {
      if (themeBumpRef.current !== lastThemeBump) {
        lastThemeBump = themeBumpRef.current;
        needsResize = true;
        beachTileRef.current = null;
        decoTileRef.current = null;
      }
      if (needsResize) {
        resize();
        needsResize = false;
      }
      const w = prevW;
      const h = prevH;
      const theme = themeRef.current;
      if (w <= 0 || h <= 0 || !theme) {
        rafId = requestAnimationFrame(render);
        return;
      }
      const dt = prevMs === 0 ? 16 : Math.min(64, timeMs - prevMs);
      const dtSec = dt / 1000;
      prevMs = timeMs;
      const t = timeMs / 1000;
      const intensityDecay = 1 - Math.pow(INTENSITY_DECAY_RETAIN_PER_500MS, dtSec / 0.5);
      intensityRef.current += (BASE_INTENSITY - intensityRef.current) * intensityDecay;
      const intensity = intensityRef.current;
      const scene = sceneRef.current;
      const layout = computeLayout(w, h);
      ensureBeachTiles(layout, h);
      ensureWeatherState(scene, w, h);
      computeWaveCrests(layout, w, t, intensity, waveCrests.current);
      const crests = waveCrests.current;

      // 1. Sky (gradient + horizon glow + day/night tint).
      const phase = celestialPhase();
      drawSky(ctx, scene, w, h, theme, phase);

      // 2. Stars at night (only when sky isn't fully blanketed by storm clouds).
      const nightAlpha = Math.max(0, 1 - phase.light);
      if (scene !== "fog" && scene !== "storm" && nightAlpha > 0.15) {
        drawStars(ctx, w, h, t, nightAlpha * (scene === "clear" ? 1 : 0.55));
      }

      // 3. Celestial body — sun by day, moon by night, hidden when overcast.
      if (scene === "clouds" || scene === "rain" || scene === "storm") {
        drawClouds(ctx, cloudsRef, w, h, dtSec, scene);
      }
      if (scene === "clear" || scene === "snow") {
        if (phase.isNight) drawMoon(ctx, w, h, t);
        else drawSun(ctx, w, h, t);
      }
      if (scene === "fog") {
        drawFog(ctx, w, h, t);
      }

      // 4. Sea + waves + foam crest (darkened at night).
      drawSea(ctx, layout, crests, w, h, scene, t, phase);

      // 5. Beach (tiled sand + decorations + shore wash with chop).
      drawBeach(ctx, layout, beachTileRef.current, decoTileRef.current, w, h, intensity, t);
      drawShoreChop(ctx, layout, w, h, t, intensity);

      // 5. Slots (mascots / icons) and their bubble trails.
      const atlas = atlasRef.current;
      for (const slot of slotsMapRef.current.values()) {
        updateSlot(slot, dtSec, t, layout, w, crests, bubblesRef);
      }
      drawSlots(ctx, slotsMapRef.current, atlas, layout, theme, crests, w, h, t);

      // 6. Bubbles (errored mascots).
      const bubbles = bubblesRef.current;
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        b.ageMs += dt;
        b.yPx -= dtSec * 22;
        if (b.ageMs > BUBBLE_LIFE_MS || b.yPx < -2) {
          bubbles.splice(i, 1);
          continue;
        }
        const a = 0.7 * (1 - b.ageMs / BUBBLE_LIFE_MS);
        const x = Math.round(b.xPx + Math.sin((b.ageMs / 200) + b.size) * 0.6);
        const y = Math.round(b.yPx);
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        ctx.fillStyle = `rgba(220, 240, 250, ${a.toFixed(3)})`;
        ctx.fillRect(x, y, b.size, b.size);
        ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.9).toFixed(3)})`;
        ctx.fillRect(x, y, 1, 1);
      }

      // 7. Foreground particle weather (rain/snow over everything).
      if (scene === "rain" || scene === "storm") {
        drawRain(ctx, dropsRef.current ?? [], w, h, t, scene === "storm");
      }
      if (scene === "snow") {
        drawSnow(ctx, flakesRef.current ?? [], w, h, dtSec, t);
      }

      // 8. Storm bolt + flash.
      if (scene === "storm") {
        drawStormBolt(ctx, w, h, t);
        drawStormFlash(ctx, w, h, t);
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrapperRef} className="header-activity-viz" aria-hidden="true">
      <canvas ref={canvasRef} className="header-activity-viz-canvas" />
    </div>
  );
}

function updateSlot(
  slot: Slot,
  dtSec: number,
  t: number,
  layout: Layout,
  w: number,
  crests: Float32Array,
  bubblesRef: { current: Bubble[] },
): void {
  const isErrored = slot.state === "error" || slot.state === "interrupted";
  const isIdle = !isErrored && isSessionIdle(slot.state);
  const isActive = !isErrored && !isIdle;

  const targetDive = isErrored ? 1 : 0;
  slot.diveT += (targetDive - slot.diveT) * 0.06;
  if (slot.diveT < 0.001) slot.diveT = 0;

  if (isActive) {
    const minX = layout.beachW + 4;
    if (slot.xPx < minX) {
      slot.xPx = minX;
      slot.dir = 1;
    }
    slot.xPx += slot.dir * slot.speedPxPerS * dtSec;
    if (slot.dir > 0 && slot.xPx >= w - MASCOT_PX) {
      slot.xPx = w - MASCOT_PX;
      slot.dir = -1;
    } else if (slot.dir < 0 && slot.xPx <= minX) {
      slot.xPx = minX;
      slot.dir = 1;
    }
  } else if (isIdle) {
    slot.xPx += (slot.homeXPx - slot.xPx) * Math.min(1, dtSec * 5);
  } else {
    slot.bubbleAccumMs += dtSec * 1000;
    if (slot.diveT > 0.4 && slot.bubbleAccumMs >= BUBBLE_INTERVAL_MS) {
      slot.bubbleAccumMs = 0;
      const xc = clampPx(slot.xPx + MASCOT_PX / 2, w - 1);
      const baseY = crests[Math.floor(xc)] + 6 + slot.diveT * 8;
      bubblesRef.current.push({
        xPx: slot.xPx + MASCOT_PX / 2 + Math.sin(t * 5 + slot.jitterSeed) * 2,
        yPx: baseY,
        ageMs: 0,
        size: 1 + ((Math.floor(t * 3) + Math.floor(slot.jitterSeed * 5)) % 2),
      });
    }
  }
  void layout;
}

function drawSlots(
  ctx: CanvasRenderingContext2D,
  slots: Map<string, Slot>,
  atlas: SpriteAtlas | null,
  layout: Layout,
  theme: ThemeProps,
  crests: Float32Array,
  w: number,
  h: number,
  t: number,
): void {
  for (const slot of slots.values()) {
    const isErrored = slot.state === "error" || slot.state === "interrupted";
    const isIdle = !isErrored && isSessionIdle(slot.state);
    const isActive = !isErrored && !isIdle;
    let alpha: number;
    if (isErrored) {
      alpha = Math.max(0, 0.95 - slot.diveT * 0.6);
    } else if (isActive) {
      alpha = slot.isSubagent ? 0.9 : 1;
    } else {
      alpha = slot.isSubagent ? 0.6 : 0.75;
      if (slot.isCompleted) alpha *= 0.7;
    }
    if (alpha <= 0) continue;

    const sizePx = slot.isSubagent ? SUBAGENT_PX : MASCOT_PX;
    let cx: number;
    let cy: number;
    let tilt = 0;
    if (isActive || isErrored) {
      cx = slot.xPx + sizePx / 2;
      const idx = Math.floor(clampPx(cx, w - 1));
      const crestY = crests[idx];
      // Slope estimate for tilt based on local wave gradient.
      const left = crests[Math.max(0, idx - 4)];
      const right = crests[Math.min(w - 1, idx + 4)];
      tilt = Math.max(-0.35, Math.min(0.35, (right - left) / 14));
      if (isActive) {
        const bob = Math.sin(t * 4 + slot.jitterSeed) * MASCOT_HOVER_PX;
        cy = crestY - sizePx / 2 - 2 + bob;
      } else {
        // Diving: descend below crest with diveT, fade out.
        cy = crestY + sizePx / 2 + slot.diveT * 8;
        tilt += slot.diveT * 0.45;
      }
    } else {
      // Idle on the beach, sitting along the slope.
      const slopeT = clampPx(slot.homeXPx, layout.beachW) / Math.max(1, layout.beachW);
      const beachY = layout.beachTopYAtZero + slopeT * layout.beachShoreSlope;
      const bob = Math.sin(t * 1.6 + slot.jitterSeed) * 0.6;
      cx = slot.xPx + sizePx / 2;
      cy = beachY - sizePx / 2 + bob - 1;
    }
    const xDraw = Math.round(cx - sizePx / 2);
    const yDraw = Math.round(cy - sizePx / 2);
    if (xDraw + sizePx < 0 || xDraw > w || yDraw + sizePx < 0 || yDraw > h) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    if (tilt !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.translate(-cx, -cy);
    }
    // Surfboard sits beneath the mascot when actively riding the wave.
    // Subagents and idle/errored mascots don't get one.
    if (isActive && !slot.isSubagent) {
      drawSurfboard(ctx, cx, cy + sizePx / 2 - 1, slot.cli);
    }
    if (slot.isSubagent && atlas) {
      const key = subagentKeyFor(slot.subagentType);
      const sprite = atlas.subagent.get(key);
      if (sprite) {
        ctx.drawImage(sprite, xDraw, yDraw, sizePx, sizePx);
      }
    } else if (atlas) {
      const sprite = isErrored
        ? slot.cli === "claude"
          ? atlas.claudeError
          : atlas.codexError
        : slot.cli === "claude"
          ? atlas.claude
          : atlas.codex;
      ctx.drawImage(sprite, xDraw, yDraw, sizePx, sizePx);
    } else {
      // Atlas not yet loaded — fall back to a coloured 1px square so we don't
      // pop in awkwardly. Tiny, not the main visual.
      ctx.fillStyle = slot.cli === "claude" ? theme.cliClaude : theme.cliCodex;
      ctx.fillRect(xDraw, yDraw, sizePx, sizePx);
    }
    ctx.restore();
  }
}

function drawSurfboard(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cli: "claude" | "codex",
): void {
  // 24 px long, 4 px tall stylised surfboard. Slight overhang either side of
  // the mascot reads clearly without looking comically large.
  const half = 12;
  const top = cli === "claude" ? "#f0a06c" : "#7ad6dc";
  const body = cli === "claude" ? "#c46e3a" : "#3aa5b0";
  const dark = cli === "claude" ? "#7c3f1c" : "#1f6973";
  const x0 = Math.round(cx - half);
  const y0 = Math.round(cy);
  // Drop shadow on the wave below the board.
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.fillRect(x0 + 2, y0 + 3, half * 2 - 3, 1);
  // Body with tucked tips.
  ctx.fillStyle = body;
  ctx.fillRect(x0 + 1, y0, half * 2 - 1, 3);
  // Pointed nose & tail.
  ctx.fillStyle = top;
  ctx.fillRect(x0, y0 + 1, 1, 2);
  ctx.fillRect(x0 + half * 2 - 1, y0 + 1, 1, 2);
  // Bright top stripe runs the length of the deck.
  ctx.fillStyle = top;
  ctx.fillRect(x0 + 1, y0, half * 2 - 1, 1);
  // Centre grip/fin accent.
  ctx.fillStyle = dark;
  ctx.fillRect(x0 + half - 1, y0 + 1, 2, 2);
}
