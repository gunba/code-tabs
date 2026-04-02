import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme } from "../lib/theme";
import { dlog } from "../lib/debugLog";

export const TERMINAL_FONT_FAMILY = "'Pragmasevka', 'Roboto Mono', monospace";

const PROMPT_MARKER_NEW = ">\u00A0"; // > + NBSP — current Claude Code prompt
const PROMPT_MARKER_OLD = "\u276F"; // ❯ — legacy Claude Code prompt
// [PT-08] 2-line tolerance for near-bottom snap detection
const BOTTOM_TOLERANCE = 2;

// Minimal buffer type for findPromptLine (structural typing)
interface BufferLike {
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

// [TR-08] Scan buffer backward for Claude Code prompt markers
function findPromptLine(buf: BufferLike, fromLine: number): number {
  const stop = Math.max(0, fromLine - 50_000);
  for (let i = fromLine; i >= stop; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.includes(PROMPT_MARKER_NEW) || text.includes(PROMPT_MARKER_OLD)) {
      return i;
    }
  }
  return -1;
}

interface UseTerminalOptions {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function useTerminal({ onData, onResize }: UseTerminalOptions = {}) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachedRef = useRef(false);
  const pendingElRef = useRef<HTMLDivElement | null>(null);

  // Write batching — accumulate PTY chunks and flush via debounce.
  // ConPTY fragments Ink's redraws into many small chunks; batching
  // coalesces them so DEC 2026 sync blocks (BSU+content+ESU) arrive
  // in a single term.write() call.
  const writeBatchRef = useRef<Uint8Array[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceStartRef = useRef(0);
  const webglRef = useRef<WebglAddon | null>(null);

  // Helper: open terminal in a DOM element (called once fonts + element are both ready)
  const openTerminal = useCallback((term: Terminal, fit: FitAddon, el: HTMLDivElement) => {
    if (attachedRef.current) return;

    term.open(el);
    attachedRef.current = true;

    // [DF-06] WebGL renderer for performance, with context loss recovery (retry once, fallback to canvas)
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglRef.current = null;
        // Retry once after 1s — if it fails again, stay on canvas
        setTimeout(() => {
          try {
            const retry = new WebglAddon();
            retry.onContextLoss(() => { retry.dispose(); webglRef.current = null; });
            term.loadAddon(retry);
            webglRef.current = retry;
          } catch {}
        }, 1000);
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
    } catch {
      // WebGL not available — canvas fallback is automatic
    }

    // Block xterm.js native paste handler — our custom Ctrl+V handler
    // in attachCustomKeyEventHandler handles paste via navigator.clipboard.
    // Without this, Tauri's permission dialog triggers a synthetic paste
    // event that xterm.js also handles, causing double-paste.
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true); // Capture phase — intercept before xterm.js

    try {
      const dims = fit.proposeDimensions();
      if (dims && dims.rows > 1) fit.fit();
    } catch {}

    // Observe container size changes
    const observer = new ResizeObserver(() => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || dims.rows <= 1) return;
        fit.fit();
      } catch {}
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // Create terminal instance once fonts are ready
  useEffect(() => {
    let cancelled = false;
    let term: Terminal | null = null;

    (async () => {
      // Wait for fonts so xterm.js measures correct cell dimensions at open()
      await document.fonts.ready;
      if (cancelled) return;

      // [PT-06] Fixed 1M scrollback buffer — no dynamic resizing
      // [DF-05] xterm.js 6.0 with DEC 2026 synchronized output, fixed 1M scrollback
      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: TERMINAL_FONT_FAMILY,
        theme: getTerminalTheme(),
        scrollback: 1_000_000,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);

      // Custom key handlers: Ctrl+C copy, Ctrl+V paste
      // xterm.js convention: return false = "I handled this, suppress default"
      // return true = "let xterm.js handle normally"
      term.attachCustomKeyEventHandler((ev) => {
        // Block all input when a modal overlay is open
        if (document.querySelector('.launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay, .inspector-overlay')) {
          return false; // Suppress — modal is open
        }
        if (ev.ctrlKey && ev.key === "c" && ev.type === "keydown") {
          if (term!.hasSelection()) {
            navigator.clipboard.writeText(term!.getSelection());
            term!.clearSelection();
            return false; // We handled it — don't send to PTY
          }
        }
        // Handle Ctrl+V paste — read clipboard and insert into terminal
        if (ev.ctrlKey && ev.key === "v" && ev.type === "keydown") {
          navigator.clipboard.readText().then((text) => {
            if (text) term!.paste(text);
          }).catch(() => {});
          return false; // We handled it
        }
        // [TR-03] Ctrl+Home: scroll to top
        if (ev.ctrlKey && ev.key === "Home" && ev.type === "keydown") {
          term!.scrollToTop();
          return false; // We handled it
        }
        // [TR-03] Ctrl+End: scroll to bottom
        if (ev.ctrlKey && ev.key === "End" && ev.type === "keydown") {
          term!.scrollToBottom();
          return false; // We handled it
        }
        // [KB-10] Alt+1-9 blocked from PTY — handled by App.tsx global tab-switch handler
        if (ev.altKey && ev.key >= "0" && ev.key <= "9" && ev.type === "keydown") {
          return false; // We handled it (App.tsx will process)
        }
        // App-level shortcuts: return false to prevent xterm.js from processing
        // (its key encoder calls stopPropagation, killing event bubbling to App.tsx).
        if (ev.type === "keydown") {
          if (ev.ctrlKey && !ev.shiftKey && !ev.altKey &&
              (ev.key === "t" || ev.key === "w" || ev.key === "k" || ev.key === ",")) {
            return false;
          }
          if (ev.ctrlKey && ev.shiftKey && ev.key === "T" && !ev.altKey) {
            return false;
          }
          if (ev.ctrlKey && ev.key === "Tab") {
            return false;
          }
          if (ev.ctrlKey && ev.shiftKey && !ev.altKey &&
              (ev.key === "D" || ev.key === "F" || ev.key === "G" || ev.key === "R")) {
            return false;
          }
          if (ev.key === "Escape") {
            return false;
          }
        }
        return true; // Let xterm.js handle normally
      });

      termRef.current = term;
      fitRef.current = fit;

      // If attach was called before WASM was ready, open now
      if (pendingElRef.current) {
        openTerminal(term, fit, pendingElRef.current);
      }
    })();

    return () => {
      cancelled = true;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      observerRef.current?.disconnect();
      webglRef.current?.dispose();
      webglRef.current = null;
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      attachedRef.current = false;
    };
    // Intentionally empty — create once per hook lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire up onData/onResize handlers (update when callbacks change)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposables: { dispose(): void }[] = [];

    if (onData) {
      disposables.push(term.onData(onData));
    }
    if (onResize) {
      disposables.push(term.onResize(({ cols, rows }) => onResize(cols, rows)));
    }

    return () => disposables.forEach((d) => d.dispose());
  }, [onData, onResize]);

  // Ref callback to attach terminal to a DOM element
  const attach = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    pendingElRef.current = el;

    const term = termRef.current;
    const fit = fitRef.current;
    if (term && fit && !attachedRef.current) {
      openTerminal(term, fit, el);
    }
    // If term isn't ready yet, openTerminal will be called from the useEffect above
  }, [openTerminal]);

  const write = useCallback((data: string) => {
    const term = termRef.current;
    if (!term) return;
    try { term.write(data); } catch {}
  }, []);

  // Flush all accumulated write chunks as a single write.
  // Coalescing ensures DEC 2026 sync blocks (BSU+content+ESU) that arrive
  // in separate ConPTY pipe reads are written atomically.
  const flushWrites = useCallback(() => {
    const term = termRef.current;
    if (!term) return;

    const chunks = writeBatchRef.current;
    writeBatchRef.current = [];
    debounceStartRef.current = 0;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (chunks.length === 0) return;

    let merged: Uint8Array;
    if (chunks.length === 1) {
      merged = chunks[0];
    } else {
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
    }

    // [PT-20] Detect scrollback clear (baseY shrinkage) and scroll to bottom
    const buf = term.buffer.active;
    const baseYBefore = buf.baseY;

    try {
      term.write(merged);
    } catch (err) {
      dlog("terminal", null, `term.write error: ${err}`, "ERR");
    }

    if (buf.baseY < baseYBefore) {
      term.scrollToBottom();
    }
  }, []);

  // [PT-16] Debounced write: accumulates ConPTY chunks and flushes after 4ms of
  // quiet or 50ms max latency. Coalesces BSU+content+ESU into single writes
  // so DEC 2026 sync rendering works correctly.
  // [DF-03] writeBytes: debounce-batched (4ms/50ms) PTY data handler
  const writeBytes = useCallback((data: Uint8Array) => {
    const term = termRef.current;
    if (!term) return;

    writeBatchRef.current.push(data);

    if (debounceStartRef.current === 0) {
      debounceStartRef.current = performance.now();
    }

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (performance.now() - debounceStartRef.current >= 50) {
      flushWrites();
    } else {
      debounceTimerRef.current = setTimeout(flushWrites, 4);
    }
  }, [flushWrites]);

  const clear = useCallback(() => {
    termRef.current?.clear();
  }, []);

  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, []);

  const scrollToTop = useCallback(() => {
    termRef.current?.scrollToTop();
  }, []);

  const scrollToLine = useCallback((line: number) => {
    termRef.current?.scrollToLine(line);
  }, []);

  const scrollToLastUserMessage = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.active;

    // xterm.js: viewportY is absolute position, baseY is scrollback lines
    const atBottom = buf.baseY - buf.viewportY <= BOTTOM_TOLERANCE;

    if (atBottom) {
      const line = findPromptLine(buf, buf.length - 1);
      if (line >= 0) {
        term.scrollToLine(Math.max(0, line - 1));
      } else {
        term.scrollToTop();
      }
    } else {
      // Step back: find prompt above current viewport top
      // xterm.js: viewportY IS the absolute line index of viewport top
      const viewportTopAbs = buf.viewportY;
      const line = findPromptLine(buf, viewportTopAbs - 1);
      if (line >= 0) {
        term.scrollToLine(Math.max(0, line - 1));
      } else {
        term.scrollToTop();
      }
    }
  }, []);

  const isAtBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    // xterm.js: viewportY is absolute position, baseY is scrollback lines
    const buf = term.buffer.active;
    return buf.baseY - buf.viewportY <= BOTTOM_TOLERANCE;
  }, []);

  const isAtTop = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    // At top when viewport is at buffer start
    return term.buffer.active.viewportY <= 0;
  }, []);

  // [PT-09] FitAddon dimension guard — skip fit if rows <= 1 (not laid out)
  const fit = useCallback(() => {
    try {
      const f = fitRef.current;
      if (!f) return;
      const dims = f.proposeDimensions();
      if (!dims || dims.rows <= 1) return;
      f.fit();
    } catch {}
  }, []);

  const getDimensions = useCallback(() => {
    const term = termRef.current;
    if (!term) return { cols: 80, rows: 24 };
    return { cols: term.cols, rows: term.rows };
  }, []);

  const getBufferText = useCallback(() => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }, []);

  const getBufferTail = useCallback((lineCount: number) => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const start = Math.max(0, buf.length - lineCount);
    const lines: string[] = [];
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }, []);

  // Read current input from terminal buffer — authoritative, immediate,
  // independent of PTY input tracking. Strips the prompt prefix.
  const getCurrentInput = useCallback((): string => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    // xterm.js: baseY is scrollback lines above viewport, cursorY is viewport-relative
    const y = buf.baseY + buf.cursorY;
    const line = buf.getLine(y);
    if (!line) return "";
    const text = line.translateToString(true);
    // Try current prompt first ("> " with NBSP), then legacy (❯ + space)
    let promptIdx = text.lastIndexOf(PROMPT_MARKER_NEW);
    if (promptIdx < 0) promptIdx = text.lastIndexOf(PROMPT_MARKER_OLD);
    if (promptIdx >= 0) {
      // Both markers are 2 chars (new: "> " NBSP, old: "❯" + space after)
      // Strip focus event remnants ([I = focus in, [O = focus out) that leak into buffer text
      return text.slice(promptIdx + 2).replace(/\[[OI]/g, "").trimEnd();
    }
    return "";
  }, []);

  // [PT-11] Discard pending write-batch chunks and cancel debounce timer.
  // Called during respawn to prevent stale PTY data from being flushed
  // after the terminal reset (\x1bc).
  const clearPending = useCallback(() => {
    writeBatchRef.current = [];
    debounceStartRef.current = 0;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);


  return {
    attach,
    write,
    writeBytes,
    clear,
    focus,
    scrollToBottom,
    scrollToTop,
    scrollToLine,
    scrollToLastUserMessage,
    isAtBottom,
    isAtTop,
    fit,
    clearPending,
    getDimensions,
    getBufferText,
    getBufferTail,
    getCurrentInput,
    termRef,
    webglRef,
  };
}
