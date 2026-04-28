import { useEffect, useMemo, useRef } from "react";
import { useSessionStore } from "../../store/sessions";
import { useWeatherStore } from "../../store/weather";
import { isSessionIdle, type SessionState } from "../../types/session";
import { sceneForCode } from "../../lib/weatherCodes";
import { AgentMascot, type MascotState } from "../ActivityPanel/AgentMascot";
import { WeatherLayer } from "./WeatherLayer";
import { Vehicle, vehicleFor, type Vehicle as VehicleKind } from "./Vehicle";
// AgentMascot's animations + subagent dimming live in ActivityPanel.css.
// Import it explicitly so HeaderActivityViz renders correctly even when
// the side ActivityPanel hasn't been mounted yet.
import "../ActivityPanel/ActivityPanel.css";
import "./HeaderActivityViz.css";

// [HA-01] Ambient activity scene: wave bars + agents surfing left-to-right
// pinned to the wave crest, idle agents scattered on a beach on the left,
// errored agents diving below the wave with bubbles. Persistent slot state
// across sessions list churn means activate/deactivate transitions a
// single agent rather than re-shuffling the whole scene.

const BAR_COUNT = 56;
const MASCOT_SIZE = 16;
const SUBAGENT_SIZE = 12;
const BEACH_RATIO = 0.18; // left 18% is the inactive beach
const DIVE_DEPTH = 0.4;   // fraction of container height the mascot sinks into the trough
const BUBBLE_INTERVAL_MS = 260;
const BUBBLE_LIFE_MS = 1300;

interface SlotData {
  id: string;
  cli: "claude" | "codex";
  isSubagent: boolean;
  subagentType: string | null;
  isCompleted: boolean;
  state: SessionState;
}

interface SlotMutable extends SlotData {
  x: number;          // 0..1 along container width, current
  beachX: number;     // 0..BEACH_RATIO, stable random per slot
  beachY: number;     // 0..1 within beach band, stable random
  vehicle: VehicleKind;
  speed: number;      // normalized x per ms
  bobSeed: number;
  diveT: number;
  bubbleAccum: number;
}

function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function makeSlotInitial(id: string): {
  beachX: number;
  beachY: number;
  vehicle: VehicleKind;
  speed: number;
  bobSeed: number;
} {
  const h = hash32(id);
  const r1 = ((h % 1000) / 1000);
  const r2 = (((h >> 10) % 1000) / 1000);
  const r3 = (((h >> 20) % 1000) / 1000);
  return {
    beachX: 0.02 + r1 * (BEACH_RATIO - 0.04),
    beachY: r2,
    vehicle: vehicleFor(id),
    speed: 0.00006 + r3 * 0.00006, // 17–33s across the wave
    bobSeed: r1 * Math.PI * 2,
  };
}

function mascotStateForSlot(slot: SlotData): MascotState {
  if (slot.state === "error" || slot.state === "interrupted") return "idle";
  if (isSessionIdle(slot.state)) return "idle";
  if (slot.state === "toolUse") return "writing";
  return "moving";
}

export function HeaderActivityViz() {
  const containerRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<Array<HTMLDivElement | null>>(new Array(BAR_COUNT).fill(null));
  const wrappersRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const bubblesContainerRef = useRef<HTMLDivElement>(null);

  const sessions = useSessionStore((s) => s.sessions);
  const subagents = useSessionStore((s) => s.subagents);

  // Lightweight slot list for JSX. Mutable animation state lives on the ref map.
  const slots: SlotData[] = useMemo(() => {
    const out: SlotData[] = [];
    for (const s of sessions) {
      if (s.state === "dead" || s.isMetaAgent) continue;
      out.push({
        id: s.id,
        cli: s.config.cli,
        isSubagent: false,
        subagentType: null,
        isCompleted: false,
        state: s.state,
      });
      const subs = subagents.get(s.id) || [];
      for (const sub of subs) {
        if (sub.state === "dead") continue;
        // Skip subagents that have settled to idle and aren't fresh-completed.
        if (isSessionIdle(sub.state) && !sub.completed) continue;
        out.push({
          id: `${s.id}::${sub.id}`,
          cli: s.config.cli,
          isSubagent: true,
          subagentType: sub.subagentType ?? null,
          isCompleted: !!sub.completed,
          state: sub.state,
        });
      }
    }
    return out;
  }, [sessions, subagents]);

  // Persistent per-slot animation state.
  const slotsMapRef = useRef<Map<string, SlotMutable>>(new Map());

  useEffect(() => {
    const map = slotsMapRef.current;
    const seen = new Set<string>();
    for (const s of slots) {
      seen.add(s.id);
      const existing = map.get(s.id);
      if (existing) {
        existing.cli = s.cli;
        existing.isSubagent = s.isSubagent;
        existing.subagentType = s.subagentType;
        existing.isCompleted = s.isCompleted;
        existing.state = s.state;
      } else {
        const init = makeSlotInitial(s.id);
        map.set(s.id, {
          ...s,
          x: init.beachX,
          beachX: init.beachX,
          beachY: init.beachY,
          vehicle: init.vehicle,
          speed: init.speed,
          bobSeed: init.bobSeed,
          diveT: 0,
          bubbleAccum: 0,
        });
      }
    }
    for (const id of [...map.keys()]) {
      if (!seen.has(id)) map.delete(id);
    }
  }, [slots]);

  // Activity intensity, smoothed over time. 0 = quiet, 1 = saturated.
  const intensityRef = useRef(0.15);
  const lastToolCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const tickActivity = () => {
      const latest = useSessionStore.getState().sessions;
      let delta = 0;
      const present = new Set<string>();
      for (const s of latest) {
        present.add(s.id);
        const cur = s.metadata.toolCount ?? 0;
        const prev = lastToolCounts.current.get(s.id);
        if (prev === undefined) {
          lastToolCounts.current.set(s.id, cur);
          continue;
        }
        if (cur > prev) delta += cur - prev;
        lastToolCounts.current.set(s.id, cur);
      }
      for (const id of [...lastToolCounts.current.keys()]) {
        if (!present.has(id)) lastToolCounts.current.delete(id);
      }
      const burst = 1 - Math.exp(-delta / 3);
      intensityRef.current = intensityRef.current * 0.7 + (0.15 + 0.85 * burst) * 0.3;
    };
    const interval = window.setInterval(tickActivity, 500);
    return () => window.clearInterval(interval);
  }, []);

  // rAF loop drives bars, slot transforms, bubbles. No React per-frame re-renders.
  useEffect(() => {
    if (!containerRef.current) return;
    let rafId = 0;
    let prevMs = 0;

    const emitBubble = (px: number, py: number) => {
      const c = bubblesContainerRef.current;
      if (!c) return;
      const b = document.createElement("div");
      b.className = "header-activity-viz-bubble";
      b.style.transform = `translate(${px}px, ${py}px)`;
      c.appendChild(b);
      window.setTimeout(() => {
        b.remove();
      }, BUBBLE_LIFE_MS);
    };

    const tick = (timeMs: number) => {
      if (!containerRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const dtMs = prevMs === 0 ? 16 : Math.min(64, timeMs - prevMs);
      prevMs = timeMs;
      const t = timeMs / 1000;
      const intensity = intensityRef.current;

      const heights = new Array<number>(BAR_COUNT);
      for (let i = 0; i < BAR_COUNT; i++) {
        const wave = Math.sin(i * 0.42 + t * 1.7) * 0.5 + 0.5;
        const ripple = Math.sin(i * 1.31 - t * 1.05) * 0.18;
        const baseline = 0.12;
        const h = baseline + (wave + ripple) * 0.55 * intensity;
        const clamped = Math.max(0.04, Math.min(0.95, h));
        heights[i] = clamped;
        const bar = barsRef.current[i];
        if (bar) bar.style.transform = `scaleY(${clamped})`;
      }

      const containerEl = containerRef.current;
      const w = containerEl.clientWidth;
      const h = containerEl.clientHeight;
      if (w <= 0 || h <= 0) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      for (const slot of slotsMapRef.current.values()) {
        const wrapper = wrappersRef.current.get(slot.id);
        if (!wrapper) continue;

        const isErrored = slot.state === "error" || slot.state === "interrupted";
        const isIdle = !isErrored && isSessionIdle(slot.state);
        const isActive = !isIdle && !isErrored;
        const size = slot.isSubagent ? SUBAGENT_SIZE : MASCOT_SIZE;

        const targetDive = isErrored ? 1 : 0;
        slot.diveT += (targetDive - slot.diveT) * 0.08;
        if (slot.diveT < 0.001) slot.diveT = 0;

        let xPix = 0;
        let yPix = 0;
        let opacity = 0.9;
        let vehicleVisible = false;

        if (isActive) {
          slot.x += slot.speed * dtMs;
          if (slot.x > 1.05) slot.x = -0.05;
          xPix = slot.x * w;
          const xClamped = Math.max(0, Math.min(0.999, slot.x));
          const barIdx = Math.min(BAR_COUNT - 1, Math.floor(xClamped * BAR_COUNT));
          const barH = heights[barIdx];
          const wavePixelTop = h - barH * h;
          const bob = Math.sin(t * 2.3 + slot.bobSeed) * 1.0;
          yPix = wavePixelTop - size + bob;
          opacity = slot.isSubagent ? 0.7 : 0.9;
          vehicleVisible = !slot.isSubagent;
        } else if (isIdle) {
          slot.x += (slot.beachX - slot.x) * 0.06;
          xPix = slot.x * w;
          const beachTop = h * 0.45;
          const beachBottom = h - size - 1;
          yPix = beachTop + slot.beachY * Math.max(0, beachBottom - beachTop);
          opacity = slot.isSubagent ? 0.45 : 0.6;
          if (slot.isCompleted) opacity *= 0.7;
        } else {
          // Errored: dive at last x, bubbles drift up.
          xPix = slot.x * w;
          const xClamped = Math.max(0, Math.min(0.999, slot.x));
          const barIdx = Math.min(BAR_COUNT - 1, Math.floor(xClamped * BAR_COUNT));
          const barH = heights[barIdx];
          const wavePixelTop = h - barH * h;
          const diveDepth = h * DIVE_DEPTH;
          yPix = wavePixelTop - size + slot.diveT * diveDepth;
          opacity = (slot.isSubagent ? 0.7 : 0.9) - slot.diveT * 0.55;

          slot.bubbleAccum += dtMs;
          if (slot.diveT > 0.4 && slot.bubbleAccum >= BUBBLE_INTERVAL_MS) {
            slot.bubbleAccum = 0;
            emitBubble(xPix - 1, yPix + size - 2);
          }
        }

        wrapper.style.transform = `translate(${xPix - size / 2}px, ${yPix}px)`;
        wrapper.style.opacity = `${Math.max(0, opacity)}`;
        wrapper.style.zIndex = isErrored ? "1" : "2";

        const veh = wrapper.querySelector(".header-activity-viz-vehicle") as HTMLElement | null;
        if (veh) veh.style.opacity = vehicleVisible ? "0.85" : "0";
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, []);

  const weatherCode = useWeatherStore((s) => s.weatherCode);
  const scene = sceneForCode(weatherCode);

  return (
    <div ref={containerRef} className="header-activity-viz" aria-hidden="true">
      <div className="header-activity-viz-beach" />
      <WeatherLayer scene={scene} />
      <div className="header-activity-viz-wave">
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <div
            key={i}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
            className="header-activity-viz-bar"
          />
        ))}
      </div>
      <div className="header-activity-viz-bubbles" ref={bubblesContainerRef} />
      {slots.map((slot) => {
        const size = slot.isSubagent ? SUBAGENT_SIZE : MASCOT_SIZE;
        const v = vehicleFor(slot.id);
        return (
          <div
            key={slot.id}
            ref={(el) => {
              if (el) wrappersRef.current.set(slot.id, el);
              else wrappersRef.current.delete(slot.id);
            }}
            className="header-activity-viz-mascot-wrap"
            data-slot-id={slot.id}
          >
            <AgentMascot
              state={mascotStateForSlot(slot)}
              cli={slot.cli}
              isSubagent={slot.isSubagent}
              subagentType={slot.subagentType}
              isCompleted={slot.isCompleted}
              size={size}
            />
            <Vehicle vehicle={v} size={size} />
          </div>
        );
      })}
    </div>
  );
}
