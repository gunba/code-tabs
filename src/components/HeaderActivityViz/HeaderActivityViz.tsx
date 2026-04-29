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

interface Seagull {
  xPx: number;
  baseY: number;
  speedPxPerS: number;
  dir: 1 | -1;
  flapPhase: number;
  swaySeed: number;
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
  const beachW = Math.max(96, Math.min(180, Math.round(w * 0.13)));
  const seaMeanY = Math.round(h * 0.62);
  const waveAmpMaxPx = Math.max(5, Math.round(h * 0.13));
  // Maximum dune crest elevation above sea level. Side-view ("ant-farm")
  // perspective: the beach is a real silhouette against the sky, not a
  // top-down ribbon, so the elevation is set boldly to give the dune
  // visible profile and somewhere for landmarks to stand.
  const beachShoreSlope = Math.max(14, Math.round(h * 0.32));
  return {
    beachW,
    beachShoreSlope,
    seaMeanY,
    waveAmpMaxPx,
    beachTopYAtZero: seaMeanY - beachShoreSlope,
    skyHorizonY: Math.round(h * 0.45),
  };
}

function smoothstep(u: number): number {
  const c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
}

// Side-view dune profile: rises from inland, plateaus across a crest,
// descends gently, then drops sharply at the bank to meet the water.
// Returns the Y of the sand surface at parametric x (localT in 0..1).
export function shoreYAt(layout: Layout, localT: number): number {
  const tt = Math.max(0, Math.min(1, localT));
  let elev: number;
  if (tt < 0.15) {
    // Quick rise from the inland edge up to crest height.
    elev = 0.65 + smoothstep(tt / 0.15) * 0.3;
  } else if (tt < 0.45) {
    // Plateau across the dune crest.
    elev = 0.95;
  } else if (tt < 0.85) {
    // Gentle descent down the seaward face.
    const u = (tt - 0.45) / 0.4;
    elev = 0.95 - smoothstep(u) * 0.55;
  } else {
    // Sharp bank drop to sea level.
    const u = (tt - 0.85) / 0.15;
    elev = 0.4 - smoothstep(u) * 0.4;
  }
  return layout.seaMeanY - elev * layout.beachShoreSlope;
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

// Day/night phase from the user's local clock, ideally aligned with the
// real sunrise/sunset for their actual location (Open-Meteo daily). Falls
// back to a fixed 6 / 18 curve when those aren't available.
//
// Returns:
//   light    — 0 (night) … 1 (peak day)
//   twilight — 0..1 amount of dawn/dusk warm tint
//   isNight  — true when the moon should be drawn instead of the sun
export function celestialPhase(
  sunriseHour?: number | null,
  sunsetHour?: number | null,
  date: Date = new Date(),
): { light: number; twilight: number; isNight: boolean } {
  const h = date.getHours() + date.getMinutes() / 60;
  const sr = sunriseHour ?? 6;
  const ss = sunsetHour ?? 18;
  const dayLen = Math.max(0.5, ss - sr);
  // Smooth daylight curve: 0 at sunrise, peak at solar noon, 0 at sunset.
  const phaseT = (h - sr) / dayLen;
  const daylight = phaseT >= 0 && phaseT <= 1 ? Math.sin(phaseT * Math.PI) : 0;
  // Twilight bumps centred on actual sunrise/sunset times. Narrow Gaussian.
  const dawn = Math.exp(-Math.pow((h - sr) / 0.9, 2));
  const dusk = Math.exp(-Math.pow((h - ss) / 0.9, 2));
  const twilight = Math.max(dawn, dusk);
  const isNight = h < sr || h >= ss;
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
  const cx = w - 36;
  const cy = 22;
  const radius = 11;
  // Wide outer halo with two stops — gives the moon a real glow rather than
  // sitting flat on the sky.
  const haloR = radius + 24;
  const halo = ctx.createRadialGradient(cx, cy, radius - 1, cx, cy, haloR);
  halo.addColorStop(0, "rgba(225, 235, 255, 0.55)");
  halo.addColorStop(0.4, "rgba(210, 225, 255, 0.22)");
  halo.addColorStop(1, "rgba(190, 210, 255, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);
  // Subtle pulse so the moon breathes very slightly.
  const pulse = 0.92 + 0.08 * Math.sin(t * 0.6);
  // Disc.
  const disc = ctx.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, radius);
  disc.addColorStop(0, `rgba(255, 252, 230, ${pulse.toFixed(3)})`);
  disc.addColorStop(0.55, `rgba(238, 232, 200, ${(pulse * 0.95).toFixed(3)})`);
  disc.addColorStop(1, `rgba(180, 174, 145, ${(pulse * 0.92).toFixed(3)})`);
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  // Phase shadow — soft crescent on the right side so the moon has form.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  const phaseGrad = ctx.createLinearGradient(cx - radius, 0, cx + radius, 0);
  phaseGrad.addColorStop(0, "rgba(20, 25, 45, 0)");
  phaseGrad.addColorStop(0.6, "rgba(20, 25, 45, 0)");
  phaseGrad.addColorStop(1, "rgba(20, 25, 45, 0.55)");
  ctx.fillStyle = phaseGrad;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.restore();
  // Crater dimples for character.
  ctx.fillStyle = "rgba(110, 102, 76, 0.35)";
  ctx.fillRect(cx - 4, cy - 2, 3, 2);
  ctx.fillRect(cx + 1, cy + 3, 2, 2);
  ctx.fillRect(cx - 2, cy + 4, 1, 1);
  ctx.fillStyle = "rgba(90, 84, 60, 0.4)";
  ctx.fillRect(cx + 3, cy - 4, 2, 1);
}

// Vertical moonlit reflection on the water below the moon. Wobbly bright
// strip whose alpha decays with depth so it fades into the sea. Skipped
// when the moon would be over the beach.
function drawMoonReflection(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  layout: Layout,
  crests: Float32Array,
  t: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  const moonCx = w - 36;
  if (moonCx < layout.beachW + 6) return;
  const startY = Math.max(layout.seaMeanY - layout.waveAmpMaxPx, 24);
  const endY = h - 1;
  const length = endY - startY;
  if (length <= 4) return;
  for (let yi = 0; yi < length; yi++) {
    const y = startY + yi;
    if (y < 0 || y >= h) continue;
    const depth = yi / length;
    // Reflection brightens just below the wave crest, then fades fast.
    const fade = Math.max(0, 1 - depth * 1.4) * alpha;
    if (fade <= 0.02) continue;
    // Wobble grows with depth — closer-to-camera ripples spread further.
    const wobble1 = Math.sin(y * 0.7 + t * 1.3) * (1.2 + depth * 5);
    const wobble2 = Math.sin(y * 1.4 + t * 0.7) * (0.6 + depth * 2.5);
    const cx = moonCx + wobble1 + wobble2;
    const halfWidth = 1 + Math.floor(depth * 2);
    // Don't paint reflection above the wave surface at this column.
    const colIdx = Math.floor(Math.max(0, Math.min(w - 1, cx)));
    if (y <= crests[colIdx]) continue;
    // Inner bright pixel.
    ctx.fillStyle = `rgba(245, 250, 255, ${(fade * 0.85).toFixed(3)})`;
    ctx.fillRect(Math.round(cx), y, 1, 1);
    // Soft side pixels.
    if (halfWidth >= 1) {
      ctx.fillStyle = `rgba(220, 232, 250, ${(fade * 0.45).toFixed(3)})`;
      ctx.fillRect(Math.round(cx) - halfWidth, y, halfWidth, 1);
      ctx.fillRect(Math.round(cx) + 1, y, halfWidth, 1);
    }
  }
}

// Cool silver-blue sparkles scattered across the sea surface. Independent
// of the moon — they just imply that a still ocean still catches stray
// light. Used at night to keep the water from looking flat black.
function drawNightSeaSparkles(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  crests: Float32Array,
  w: number,
  h: number,
  t: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  const beachW = layout.beachW;
  const tBucket = Math.floor(t * 1.6);
  for (let x = beachW + 4; x < w; x += 14) {
    const seed = ((x * 53 + tBucket * 91) >>> 0) % 100;
    if (seed < 45) {
      const y = Math.floor(crests[x]) + 3 + (seed % 4);
      if (y >= 0 && y < h) {
        const a = alpha * (0.4 + (seed % 7) / 14);
        ctx.fillStyle = `rgba(225, 235, 250, ${a.toFixed(3)})`;
        ctx.fillRect(x + (seed % 3), y, 1, 1);
      }
    }
  }
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
  const { beachW, beachTopYAtZero } = layout;
  if (!beachTile || !decoTile) return;
  // Sand fill, clipped to the curved beach top (mostly flat with a bank
  // dropping off into the water at the right side). The path is sampled
  // along shoreYAt at 1-px x steps so the curve reads as smooth.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, beachTopYAtZero);
  for (let x = 1; x <= beachW; x++) {
    ctx.lineTo(x, shoreYAt(layout, x / beachW));
  }
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

  // Big landmarks (umbrella, towel, sandcastle) drawn ON TOP of the dune
  // curve so they sit as silhouettes against the sky, not embedded inside.
  drawBeachLandmarks(ctx, layout);

  // Bank shadow: the curved drop near the water edge gets a 1–2 px
  // darkening to imply the cliff face — not a real 3D normal, just a hint.
  ctx.fillStyle = "rgba(60, 40, 22, 0.45)";
  for (let x = Math.round(beachW * 0.7); x < beachW; x++) {
    const local = x / Math.max(1, beachW);
    const yTop = Math.round(shoreYAt(layout, local));
    if (yTop >= 0 && yTop < h) ctx.fillRect(x, yTop, 1, 1);
    if (yTop + 1 < h) {
      ctx.fillStyle = "rgba(60, 40, 22, 0.25)";
      ctx.fillRect(x, yTop + 1, 1, 1);
      ctx.fillStyle = "rgba(60, 40, 22, 0.45)";
    }
  }

  // Damp-sand band just inside the shore — darker, wet, ~3 px tall, but
  // only along the lower (sloped) portion of the beach.
  ctx.fillStyle = "rgba(80, 50, 25, 0.28)";
  for (let x = Math.round(beachW * 0.5); x < beachW; x++) {
    const local = x / Math.max(1, beachW);
    const yTop = Math.round(shoreYAt(layout, local));
    for (let dy = 1; dy <= 3; dy++) {
      if (yTop + dy < h) ctx.fillRect(x, yTop + dy, 1, 1);
    }
  }

  // Foam wash kissing the bank — clipped to the water side so it never
  // appears on the sand. Two overlapping sines produce an organic edge.
  const washPhase = t * 1.8;
  const washAmp = 0.6 + intensity * 1.2;
  for (let x = 0; x < beachW; x++) {
    const local = x / Math.max(1, beachW);
    const baseY = shoreYAt(layout, local);
    const s1 = Math.sin(x * 0.32 + washPhase) * washAmp;
    const s2 = Math.sin(x * 0.18 - washPhase * 0.7 + 1.4) * washAmp * 0.6;
    // Foam is ALWAYS at-or-below the bank line — never above it.
    const yEdge = Math.max(Math.round(baseY) + 1, Math.round(baseY + s1 + s2));
    if (yEdge >= 0 && yEdge < h) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fillRect(x, yEdge, 1, 1);
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

// Pre-rendered tile holding only the small surface decorations (pebbles,
// shells, conch, starfish, driftwood, footprints). Big landmarks
// (umbrella, towel, sandcastle) are drawn on top of the dune by drawBeach
// so they appear as silhouettes against the sky, not embedded in the
// sand. The tile is masked by the sand clip path at draw time.
function makeBeachDecoTile(beachW: number, h: number, layout: Layout): HTMLCanvasElement {
  const c = makeOffscreen(beachW, h);
  const ctx = c.getContext("2d")!;

  // Scatter small ornaments along the curved sand surface — each one
  // anchored just below the dune top so they sit "on" the sand rather
  // than floating in the air.
  const rng = mulberry32(0x9e3779b1);
  const decoCount = Math.max(4, Math.round(beachW / 18));
  for (let i = 0; i < decoCount; i++) {
    const x = Math.floor(rng() * (beachW - 6)) + 2;
    const surfaceY = shoreYAt(layout, x / Math.max(1, beachW));
    const offsetY = 1 + Math.floor(rng() * 3);
    const y = Math.round(surfaceY + offsetY);
    if (y >= h - 1) continue;
    const kind = Math.floor(rng() * 5);
    drawDeco(ctx, x, y, kind, rng);
  }

  // Footprint trail walking along the dune toward the water.
  const trailRng = mulberry32(0xabcdef01);
  let fx = Math.round(beachW * 0.35);
  for (let s = 0; s < 5; s++) {
    const surfaceY = shoreYAt(layout, fx / Math.max(1, beachW));
    const fy = Math.round(surfaceY) + 2 + (s % 2);
    if (fy < h && fx < beachW - 2) drawFootprint(ctx, fx, fy, s % 2 === 0);
    fx += 6 + Math.floor(trailRng() * 4);
    if (fx > beachW - 4) break;
  }
  return c;
}

// Draw the big landmark silhouettes (umbrella, towel, sandcastle) ON TOP
// of the dune curve. Anchored to the sand surface via shoreYAt so they
// follow the topography. Drawn after the clip restore so anything taller
// than the dune is visible against the sky.
function drawBeachLandmarks(ctx: CanvasRenderingContext2D, layout: Layout): void {
  const beachW = layout.beachW;
  // Umbrella sits on the dune crest plateau (roughly 0.30 of beach width).
  const umbrellaT = 0.3;
  const umbrellaCx = Math.round(beachW * umbrellaT);
  const umbrellaSurfaceY = shoreYAt(layout, umbrellaT);
  drawUmbrella(ctx, umbrellaCx, Math.round(umbrellaSurfaceY));

  // Towel a bit further down-slope from the umbrella.
  const towelT = 0.5;
  const towelCx = Math.round(beachW * towelT);
  const towelSurfaceY = shoreYAt(layout, towelT);
  drawTowel(ctx, towelCx, Math.round(towelSurfaceY));

  // Sandcastle on the gentle descent before the bank drop.
  const castleT = 0.66;
  const castleCx = Math.round(beachW * castleT);
  const castleSurfaceY = shoreYAt(layout, castleT);
  drawSandcastle(ctx, castleCx, Math.round(castleSurfaceY));
}

function drawUmbrella(ctx: CanvasRenderingContext2D, cx: number, surfaceY: number): void {
  // Side-view beach umbrella: 13-wide canopy + 18-tall pole anchored to the
  // sand at surfaceY. Drawn taller and wider than before so it reads at a
  // glance.
  const poleHeight = 18;
  const canopyTopY = surfaceY - poleHeight;
  // Pole.
  ctx.fillStyle = "#3a2410";
  ctx.fillRect(cx, canopyTopY + 1, 1, poleHeight);
  ctx.fillStyle = "#5b3a1c";
  ctx.fillRect(cx + 1, canopyTopY + 1, 1, poleHeight);
  // Canopy: 7-row half-disc, alternating red and cream stripes.
  const stripes = ["#d44a3a", "#f4f1e6", "#d44a3a", "#f4f1e6", "#d44a3a", "#f4f1e6", "#d44a3a"];
  const widths = [2, 4, 6, 8, 10, 11, 12];
  for (let i = 0; i < widths.length; i++) {
    ctx.fillStyle = stripes[i];
    ctx.fillRect(cx - widths[i], canopyTopY + i, widths[i] * 2 + 1, 1);
  }
  // Bright top finial.
  ctx.fillStyle = "#fff5c9";
  ctx.fillRect(cx, canopyTopY - 1, 1, 1);
  // Canopy underside shadow.
  ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
  ctx.fillRect(cx - widths[widths.length - 1] + 1, canopyTopY + widths.length, widths[widths.length - 1] * 2 - 1, 1);
  // Pole shadow on the sand at the base.
  ctx.fillStyle = "rgba(40, 25, 10, 0.4)";
  ctx.fillRect(cx - 2, surfaceY + 1, 5, 1);
}

function drawTowel(ctx: CanvasRenderingContext2D, cx: number, surfaceY: number): void {
  // Side-view beach towel: 22 px wide, 3 px tall, lying on the sand.
  // Visible from the side as a flat striped strip with fringe at both ends.
  const w = 22;
  const x0 = cx - Math.floor(w / 2);
  const y0 = surfaceY - 1;
  const stripes = ["#3aa1c0", "#f4d35a", "#d96666", "#5fb09a", "#3aa1c0", "#f4d35a"];
  // Towel face — top row brighter, bottom row shadowed for depth.
  for (let i = 0; i < w; i++) {
    const s = Math.floor((i / w) * stripes.length);
    const col = stripes[Math.min(stripes.length - 1, s)];
    ctx.fillStyle = col;
    ctx.fillRect(x0 + i, y0 - 1, 1, 1);
    ctx.fillStyle = withAlpha(col, 0.7);
    ctx.fillRect(x0 + i, y0, 1, 1);
  }
  // Fringe pixels.
  ctx.fillStyle = "#ece5cf";
  ctx.fillRect(x0 - 1, y0 - 1, 1, 1);
  ctx.fillRect(x0 - 1, y0, 1, 1);
  ctx.fillRect(x0 + w, y0 - 1, 1, 1);
  ctx.fillRect(x0 + w, y0, 1, 1);
  // Sand shadow.
  ctx.fillStyle = "rgba(40, 25, 10, 0.32)";
  ctx.fillRect(x0, y0 + 1, w, 1);
}

function drawSandcastle(ctx: CanvasRenderingContext2D, cx: number, surfaceY: number): void {
  // Side-view sandcastle: ~16 px wide, ~14 px tall, three towers + keep
  // with crenellations and a small flag on top. Anchored so the base sits
  // at surfaceY (the bottom of the castle is on the sand).
  const sand = "#b8893f";
  const sandLight = "#e8c47a";
  const sandShadow = "#6e4d22";
  const w = 16;
  const x0 = cx - Math.floor(w / 2);
  const baseY = surfaceY - 4;
  // Base block.
  ctx.fillStyle = sand;
  ctx.fillRect(x0, baseY, w, 4);
  ctx.fillStyle = sandLight;
  ctx.fillRect(x0, baseY, w, 1);
  ctx.fillStyle = sandShadow;
  ctx.fillRect(x0, baseY + 3, w, 1);
  // Left tower.
  ctx.fillStyle = sand;
  ctx.fillRect(x0, baseY - 6, 3, 6);
  ctx.fillStyle = sandLight;
  ctx.fillRect(x0, baseY - 6, 1, 6);
  // Right tower.
  ctx.fillStyle = sand;
  ctx.fillRect(x0 + w - 3, baseY - 6, 3, 6);
  ctx.fillStyle = sandLight;
  ctx.fillRect(x0 + w - 3, baseY - 6, 1, 6);
  // Centre keep — taller.
  const keepX = x0 + Math.floor(w / 2) - 2;
  ctx.fillStyle = sand;
  ctx.fillRect(keepX, baseY - 9, 5, 9);
  ctx.fillStyle = sandLight;
  ctx.fillRect(keepX, baseY - 9, 1, 9);
  ctx.fillStyle = sandShadow;
  ctx.fillRect(keepX + 4, baseY - 9, 1, 9);
  // Crenellations.
  ctx.fillStyle = sand;
  for (const cx2 of [x0, x0 + 2, x0 + w - 3, x0 + w - 1]) {
    ctx.fillRect(cx2, baseY - 7, 1, 1);
  }
  for (const cx2 of [keepX, keepX + 2, keepX + 4]) {
    ctx.fillRect(cx2, baseY - 10, 1, 1);
  }
  // Door arch on the front of the keep.
  ctx.fillStyle = sandShadow;
  ctx.fillRect(keepX + 2, baseY - 2, 1, 2);
  ctx.fillRect(keepX + 1, baseY - 1, 3, 1);
  // Flag pole + flag on the keep.
  ctx.fillStyle = "#3a2410";
  ctx.fillRect(keepX + 2, baseY - 12, 1, 3);
  ctx.fillStyle = "#d44a3a";
  ctx.fillRect(keepX + 3, baseY - 12, 3, 1);
  ctx.fillRect(keepX + 3, baseY - 11, 2, 1);
  // Cast shadow on the sand.
  ctx.fillStyle = "rgba(40, 25, 10, 0.3)";
  ctx.fillRect(x0 - 1, surfaceY, w + 2, 1);
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
  const { beachW } = layout;
  if (beachW <= 0) return;
  const tSubBucket = Math.floor(t * 8);
  const chopAmp = 1.5 + intensity * 2.4;

  // Foam splatter at the bank's water-facing edge. Pixels are clipped to
  // never appear above the bank line — chop must look like the sea
  // hitting the bank, not foam climbing onto the sand.
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  for (let x = 0; x < beachW + 14; x++) {
    const local = x / Math.max(1, beachW);
    const bankY = x < beachW ? shoreYAt(layout, local) : layout.seaMeanY;
    const seed = (x * 47 + tSubBucket * 31) >>> 0;
    const noise = ((seed % 211) / 211); // 0..1, all positive — only push DOWN.
    const wobble = Math.abs(Math.sin(x * 0.55 + t * 4)) * chopAmp;
    const y = Math.round(bankY + 1 + wobble + noise * chopAmp);
    if (y >= 0 && y < h) {
      ctx.fillRect(x, y, 1, 1);
    }
    if (((seed >>> 5) % 6) === 0 && y + 1 < h) {
      ctx.fillStyle = "rgba(225, 240, 250, 0.6)";
      ctx.fillRect(x, y + 1, 1, 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    }
  }

  // Spray plumes from waves slapping the bank. They rise UP to a few px
  // above the bank line — visible ABOVE the bank but not as a band that
  // implies water flowing onto the beach. We constrain them to the bank
  // shoulder (the right ~25% of the beach), where a real wave would break
  // against the small cliff.
  const tBucket = Math.floor(t * 4);
  const breakColumns = Math.max(2, Math.round(beachW / 24));
  for (let i = 0; i < breakColumns; i++) {
    const seed = (i * 1103515245 + tBucket * 12345) >>> 0;
    const phase = (seed % 9) - 1;
    if (phase < 0 || phase > 3) continue;
    const xPlume = Math.round(beachW * 0.75 + ((seed >>> 8) % Math.max(1, Math.round(beachW * 0.25))));
    const lifeT = phase / 3;
    const heightPx = (2 + ((seed >>> 12) % 3)) * (1 - lifeT * 0.5);
    const local = xPlume / Math.max(1, beachW);
    const bankY = shoreYAt(layout, local);
    for (let dy = 0; dy < heightPx; dy++) {
      const y = Math.round(bankY - dy);
      if (y < 0 || y >= h) continue;
      const a = (1 - dy / heightPx) * (1 - lifeT) * 0.85;
      ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      ctx.fillRect(xPlume + ((dy & 1) ? 1 : 0), y, 1, 1);
    }
  }
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

function drawSeagulls(
  ctx: CanvasRenderingContext2D,
  list: Seagull[],
  w: number,
  dtSec: number,
  t: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  for (const g of list) {
    g.xPx += g.dir * g.speedPxPerS * dtSec;
    if (g.dir > 0 && g.xPx > w + 8) g.xPx = -8;
    else if (g.dir < 0 && g.xPx < -8) g.xPx = w + 8;
    const y = Math.round(g.baseY + Math.sin(t * 0.6 + g.swaySeed) * 1.5);
    const frame = Math.floor((t + g.flapPhase) * 3) % 2;
    drawSeagull(ctx, Math.round(g.xPx), y, frame, alpha, g.dir);
  }
}

function drawSeagull(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  frame: number,
  alpha: number,
  dir: 1 | -1,
): void {
  // 5-px-wide silhouette. Two frames: V (wings up) and flat (wings down).
  // dir flips the asymmetric body offset so the bird "leads" with its head.
  const a = alpha.toFixed(3);
  ctx.fillStyle = `rgba(45, 50, 65, ${a})`;
  if (frame === 0) {
    // Wing tips raised, body 1 px down.
    ctx.fillRect(x, y, 1, 1);
    ctx.fillRect(x + 4, y, 1, 1);
    ctx.fillRect(x + 1, y + 1, 1, 1);
    ctx.fillRect(x + 3, y + 1, 1, 1);
    ctx.fillRect(x + 2, y + 1, 1, 1);
    // Tiny head dot leading the direction of travel.
    ctx.fillStyle = `rgba(45, 50, 65, ${(alpha * 0.8).toFixed(3)})`;
    ctx.fillRect(x + (dir > 0 ? 3 : 1), y + 2, 1, 1);
  } else {
    // Wings horizontal — a single 5-px row.
    ctx.fillRect(x, y + 1, 5, 1);
    ctx.fillStyle = `rgba(45, 50, 65, ${(alpha * 0.7).toFixed(3)})`;
    ctx.fillRect(x + 2, y + 2, 1, 1);
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
  const seagullsRef = useRef<Seagull[] | null>(null);
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
  const sunriseHour = useWeatherStore((s) => s.sunriseHour);
  const sunsetHour = useWeatherStore((s) => s.sunsetHour);
  const sunRef = useRef<{ sr: number | null; ss: number | null }>({ sr: null, ss: null });
  useEffect(() => {
    sunRef.current = { sr: sunriseHour, ss: sunsetHour };
  }, [sunriseHour, sunsetHour]);

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
    // Birds avoid weather they wouldn't actually fly in (storm/snow); reset
    // here so the scene change doesn't leave a stale flock floating around.
    seagullsRef.current = null;
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
      const wantsSeagulls =
        scene !== "storm" && scene !== "snow" && scene !== "fog";
      if (wantsSeagulls && !seagullsRef.current) {
        const list: Seagull[] = [];
        const count = 2;
        const yMax = Math.max(6, Math.floor(h * 0.45));
        for (let i = 0; i < count; i++) {
          list.push({
            xPx: ((i * w) / count + 30) % w,
            baseY: 4 + ((i * 11) % Math.max(4, yMax - 4)),
            speedPxPerS: 9 + i * 5,
            dir: i % 2 === 0 ? 1 : -1,
            flapPhase: i * 1.7,
            swaySeed: i * 2.3,
          });
        }
        seagullsRef.current = list;
      }
      if (!wantsSeagulls) seagullsRef.current = null;
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
      const phase = celestialPhase(sunRef.current.sr, sunRef.current.ss);
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

      // 3b. Seagulls drift across the sky on the daylight side. Skipped in
      // storm/snow/fog above; faded out at night with daylight alpha.
      if (seagullsRef.current && phase.light > 0.05) {
        drawSeagulls(ctx, seagullsRef.current, w, dtSec, t, 0.55 * phase.light);
      }

      // 4. Sea + waves + foam crest (darkened at night).
      drawSea(ctx, layout, crests, w, h, scene, t, phase);
      // Moonlit reflection column + cool surface sparkles only on clear-ish
      // nights — overcast skies wouldn't let the light through.
      if (
        nightAlpha > 0.25 &&
        (scene === "clear" || scene === "clouds" || scene === "snow")
      ) {
        if (scene === "clear") {
          drawMoonReflection(ctx, w, h, layout, crests, t, nightAlpha * 0.8);
        }
        drawNightSeaSparkles(ctx, layout, crests, w, h, t, nightAlpha * 0.55);
      }

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

    const start = () => {
      if (rafId !== 0) return;
      // Reset frame timing so dt doesn't snap to a huge value when resuming
      // from a long pause; otherwise the wave/intensity decay would jump.
      prevMs = 0;
      rafId = requestAnimationFrame(render);
    };
    const stop = () => {
      if (rafId === 0) return;
      cancelAnimationFrame(rafId);
      rafId = 0;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
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
        // Paddle wobble: small extra tilt + 1-px vertical kick at ~3 Hz so
        // the mascot reads as actively riding rather than statically planted.
        const paddle = Math.sin(t * 6 + slot.jitterSeed * 1.7);
        tilt += paddle * 0.05 * slot.dir;
        cy = crestY - sizePx / 2 - 2 + bob + Math.abs(paddle) * 0.6;
      } else {
        // Diving: descend below crest with diveT, fade out.
        cy = crestY + sizePx / 2 + slot.diveT * 8;
        tilt += slot.diveT * 0.45;
      }
    } else {
      // Idle mascots stand on the dune surface (curved profile via shoreYAt).
      const slopeT = clampPx(slot.homeXPx, layout.beachW) / Math.max(1, layout.beachW);
      const beachY = shoreYAt(layout, slopeT);
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
      drawPaddleSplash(ctx, cx, cy + sizePx / 2, slot.dir, t, slot.jitterSeed);
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

function drawPaddleSplash(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dir: 1 | -1,
  t: number,
  seed: number,
): void {
  // Splash dots alternate sides at ~6 Hz to read as paddling. Trailing edge
  // (opposite the direction of travel) gets a slightly bigger plume — that's
  // where the wake would actually be.
  const phase = (Math.floor((t + seed) * 6) % 2) === 0 ? 1 : -1;
  const wakeX = Math.round(cx - dir * 14);
  const oppX = Math.round(cx + dir * 11);
  const wakeY = Math.round(cy + 1);
  // Wake side (behind the mascot in travel direction).
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fillRect(wakeX, wakeY, 2, 1);
  ctx.fillStyle = "rgba(220, 240, 250, 0.55)";
  ctx.fillRect(wakeX - 1, wakeY - 1, 1, 1);
  ctx.fillRect(wakeX + 2, wakeY + 1, 1, 1);
  // Forward splash side, smaller and only on alternating frames.
  if (phase > 0) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.fillRect(oppX, wakeY, 1, 1);
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
