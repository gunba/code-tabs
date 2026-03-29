import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { IconClose } from "../Icons/Icons";
import { useTerminal } from "../../hooks/useTerminal";
import { parseRecording, decodePayload } from "../../lib/replayParser";
import type { RecordingEvent, ParsedRecording } from "../../lib/replayParser";
import { dlog } from "../../lib/debugLog";
import "./ReplayViewer.css";

interface ReplayViewerProps {
  filePath: string;
  onClose: () => void;
}

type Phase = "filtered" | "raw";

export function ReplayViewer({ filePath, onClose }: ReplayViewerProps) {
  const [recording, setRecording] = useState<ParsedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [phase, setPhase] = useState<Phase>("filtered");
  const [currentTime, setCurrentTime] = useState(0);

  const eventIndexRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const wallStartRef = useRef(0);
  const eventStartRef = useRef(0);

  const terminal = useTerminal();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Attach terminal to container
  const setContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (el) terminal.attach(el);
  }, [terminal]);

  // Load recording file
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const text: string = await invoke("read_recording_file", { path: filePath });
        if (cancelled) return;
        const parsed = parseRecording(text);
        setRecording(parsed);
      } catch (e) {
        if (cancelled) return;
        const msg = `Failed to load recording: ${e}`;
        dlog("terminal", null, msg, "ERR");
        setError(msg);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  // Get filtered events for the current phase
  const getEvents = useCallback((rec: ParsedRecording, p: Phase): RecordingEvent[] => {
    return rec.events.filter((e) => e.phase === p);
  }, []);

  // Write events up to a target time to the terminal (instant replay for seek)
  const replayTo = useCallback((rec: ParsedRecording, targetTime: number, p: Phase) => {
    const events = getEvents(rec, p);
    terminal.write("\x1bc"); // Reset terminal
    for (const ev of events) {
      if (ev.t > targetTime) break;
      if (ev.base64) {
        const data = decodePayload(ev.base64);
        terminal.termRef.current?.write(data);
      }
      if (ev.phase === "resize" && ev.cols && ev.rows) {
        terminal.termRef.current?.resize(ev.cols, ev.rows);
      }
    }
  }, [getEvents, terminal]);

  // Playback loop
  useEffect(() => {
    if (!playing || !recording) return;

    const events = getEvents(recording, phase);
    wallStartRef.current = performance.now();
    eventStartRef.current = currentTime;

    // Find starting event index
    let startIdx = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].t > currentTime) { startIdx = i; break; }
      startIdx = i + 1;
    }
    eventIndexRef.current = startIdx;

    const tick = () => {
      const elapsed = (performance.now() - wallStartRef.current) / 1000 * speed;
      const now = eventStartRef.current + elapsed;

      // Write all events up to current time
      while (eventIndexRef.current < events.length) {
        const ev = events[eventIndexRef.current];
        if (ev.t > now) break;
        if (ev.base64) {
          const data = decodePayload(ev.base64);
          terminal.termRef.current?.write(data);
        }
        if (ev.phase === "resize" && ev.cols && ev.rows) {
          terminal.termRef.current?.resize(ev.cols, ev.rows);
        }
        eventIndexRef.current++;
      }

      setCurrentTime(now);

      // Check if playback is done
      if (eventIndexRef.current >= events.length) {
        setPlaying(false);
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, recording, phase, speed, currentTime, getEvents, terminal]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); return; }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPlaying(false);
      setCurrentTime((t) => {
        const target = Math.max(0, t - 5);
        if (recording) replayTo(recording, target, phase);
        return target;
      });
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const dur = recording?.duration ?? 0;
      setCurrentTime((t) => Math.min(dur, t + 5));
      return;
    }
    if (e.key === "[") {
      setSpeed((s) => Math.max(0.25, s / 2));
      return;
    }
    if (e.key === "]") {
      setSpeed((s) => Math.min(16, s * 2));
      return;
    }
  }, [onClose, recording, phase, replayTo]);

  // Seek handler
  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!recording) return;
    const target = parseFloat(e.target.value);
    setPlaying(false);
    replayTo(recording, target, phase);
    setCurrentTime(target);
  }, [recording, phase, replayTo]);

  // Phase toggle
  const handlePhaseChange = useCallback((newPhase: Phase) => {
    if (!recording) return;
    setPlaying(false);
    setPhase(newPhase);
    replayTo(recording, currentTime, newPhase);
  }, [recording, currentTime, replayTo]);

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const filename = filePath.split(/[/\\]/).pop() ?? filePath;
  const duration = recording?.duration ?? 0;

  return createPortal(
    <div onKeyDown={handleKeyDown}>
      <ModalOverlay onClose={onClose} className="replay-modal">
        <div className="replay-header">
          <div className="replay-header-left">
            <span className="replay-filename">{filename}</span>
            {recording && (
              <span className="replay-meta">
                {recording.header.cols}x{recording.header.rows} | {formatTime(duration)}
              </span>
            )}
          </div>
          <button className="replay-close" onClick={onClose} title="Close (Esc)">
            <IconClose size={14} />
          </button>
        </div>

        <div className="replay-terminal" ref={setContainer} />

        {error && <div className="replay-error">{error}</div>}

        {recording && (
          <div className="replay-controls">
            <button
              className="replay-btn replay-play"
              onClick={() => setPlaying((p) => !p)}
              title={playing ? "Pause (Space)" : "Play (Space)"}
            >
              {playing ? "⏸" : "▶"}
            </button>

            <input
              type="range"
              className="replay-seek"
              min={0}
              max={duration}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
            />

            <span className="replay-time">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div className="replay-speed-group">
              {[0.5, 1, 2, 4, 8].map((s) => (
                <button
                  key={s}
                  className={`replay-speed${speed === s ? " active" : ""}`}
                  onClick={() => setSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </div>

            <div className="replay-phase-group">
              <button
                className={`replay-phase${phase === "filtered" ? " active" : ""}`}
                onClick={() => handlePhaseChange("filtered")}
                title="Processed output (what the user saw)"
              >
                Filtered
              </button>
              <button
                className={`replay-phase${phase === "raw" ? " active" : ""}`}
                onClick={() => handlePhaseChange("raw")}
                title="Raw PTY output (before filtering)"
              >
                Raw
              </button>
            </div>
          </div>
        )}
      </ModalOverlay>
    </div>,
    document.body
  );
}
