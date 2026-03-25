import { useEffect, useRef, useCallback } from "react";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getXtermTheme } from "../lib/theme";
import { dlog } from "../lib/debugLog";

const PROMPT_MARKER_NEW = ">\u00A0"; // > + NBSP — current Claude Code prompt
const PROMPT_MARKER_OLD = "\u276F"; // ❯ — legacy Claude Code prompt
const BOTTOM_TOLERANCE = 2; // Lines of slack for "at bottom" detection

interface UseTerminalOptions {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function useTerminal({ onData, onResize }: UseTerminalOptions = {}) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const webglRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachedRef = useRef(false);
  const markersRef = useRef<IMarker[]>([]);

  // Write batching — accumulate PTY chunks and flush via debounce.
  // ConPTY fragments ink's redraws into many small chunks; batching
  // ensures xterm.js processes them as fewer, larger writes. xterm.js 6
  // handles DEC 2026 synchronized output natively, so the batching here
  // is defense-in-depth for data that arrives outside sync blocks.
  const writeBatchRef = useRef<Uint8Array[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceStartRef = useRef(0);

  // Create terminal instance once on hook mount
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
      theme: getXtermTheme(),
      allowProposedApi: true,
      scrollback: 100000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    // Custom key handlers: Ctrl+C copy, Ctrl+V paste
    term.attachCustomKeyEventHandler((ev) => {
      // Block all input when a modal overlay is open
      if (document.querySelector('.launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay, .inspector-overlay')) {
        return false;
      }
      if (ev.ctrlKey && ev.key === "c" && ev.type === "keydown") {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
          return false; // Don't send to PTY
        }
      }
      // Handle Ctrl+V paste — read clipboard and insert into terminal
      if (ev.ctrlKey && ev.key === "v" && ev.type === "keydown") {
        navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        }).catch(() => {});
        return false; // Prevent default handling
      }
      // Ctrl+Home: scroll to top
      if (ev.ctrlKey && ev.key === "Home" && ev.type === "keydown") {
        term.scrollToTop();
        return false;
      }
      // Ctrl+End: scroll to bottom
      if (ev.ctrlKey && ev.key === "End" && ev.type === "keydown") {
        term.scrollToBottom();
        return false;
      }
      // Alt+digit: block from PTY — handled by App.tsx global tab-switch handler
      if (ev.altKey && ev.key >= "0" && ev.key <= "9" && ev.type === "keydown") {
        return false;
      }
      // Ctrl+E: block from PTY — handled by App.tsx (tab rename)
      if (ev.ctrlKey && ev.key === "e" && ev.type === "keydown") {
        return false;
      }
      return true; // Let it through
    });

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (webglRetryTimerRef.current) clearTimeout(webglRetryTimerRef.current);
      observerRef.current?.disconnect();
      webglRef.current?.dispose();
      webglRef.current = null;
      markersRef.current = [];
      term.dispose();
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
      const wrappedOnData = (data: string) => {
        if (data.includes('\r')) {
          const marker = term.registerMarker(0);
          if (marker) markersRef.current.push(marker);
        }
        onData(data);
      };
      disposables.push(term.onData(wrappedOnData));
    }
    if (onResize) {
      disposables.push(term.onResize(({ cols, rows }) => onResize(cols, rows)));
    }

    return () => disposables.forEach((d) => d.dispose());
  }, [onData, onResize]);

  // Ref callback to attach terminal to a DOM element
  const attach = useCallback((el: HTMLDivElement | null) => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!el || !term || !fit) return;

    if (attachedRef.current) return; // Already attached — skip fit/observer setup

    term.open(el);
    attachedRef.current = true;

    // Block xterm.js 6.0's native paste handler — our custom Ctrl+V handler
    // in attachCustomKeyEventHandler handles paste via navigator.clipboard.
    // Without this, the Tauri permission dialog triggers a synthetic paste
    // event that xterm.js also handles, causing double-paste.
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true); // Capture phase — intercept before xterm.js

    // Load WebGL renderer with context loss recovery.
    // On context loss: dispose, wait 1s, retry once. If retry fails,
    // xterm.js automatically falls back to the DOM canvas renderer.
    const loadWebgl = (canRetry = true) => {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          dlog("terminal", null, "WebGL context lost — disposing addon", "WARN");
          try { addon.dispose(); } catch {}
          webglRef.current = null;
          if (canRetry) {
            webglRetryTimerRef.current = setTimeout(() => loadWebgl(false), 1000);
          }
        });
        term.loadAddon(addon);
        webglRef.current = addon;
      } catch {
        webglRef.current = null;
        if (!canRetry) {
          dlog("terminal", null, "WebGL retry failed — using canvas renderer", "WARN");
        }
      }
    };
    loadWebgl();

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

  const write = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  // Flush all accumulated write chunks to xterm.js as a single write.
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

    const prevViewportY = term.buffer.active.viewportY;
    const prevBaseY = term.buffer.active.baseY;
    const wasAtBottom = prevViewportY >= prevBaseY - BOTTOM_TOLERANCE;

    // Merge chunks into a single buffer
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

    term.write(merged, () => {
      if (wasAtBottom) {
        term.scrollToBottom();
      } else {
        const newViewportY = term.buffer.active.viewportY;
        const newBaseY = term.buffer.active.baseY;
        if (newBaseY < prevBaseY) {
          // Scrollback was cleared (ESC[3J — content exceeded viewport).
          // The content the user was reading is gone — show latest output.
          term.scrollToBottom();
        } else if (newViewportY !== prevViewportY) {
          // Viewport moved unexpectedly — restore absolute position
          term.scrollToLine(Math.min(prevViewportY, newBaseY));
        }
      }
    });
  }, []);

  // Debounced write: accumulates ConPTY chunks and flushes after 4ms of
  // quiet or 50ms max latency. xterm.js 6's native DEC 2026 support
  // handles ink's synchronized output; this batching reduces writes for
  // data outside sync blocks.
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

  const scrollToLastUserMessage = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // Prune disposed markers
    markersRef.current = markersRef.current.filter(m => !m.isDisposed);
    const markers = markersRef.current;
    if (markers.length === 0) { term.scrollToTop(); return; }
    const buf = term.buffer.active;
    const atBottom = buf.viewportY >= buf.baseY - BOTTOM_TOLERANCE;
    if (atBottom) {
      term.scrollToLine(Math.max(0, markers[markers.length - 1].line - 1));
    } else {
      for (let i = markers.length - 1; i >= 0; i--) {
        if (markers[i].line < buf.viewportY) {
          term.scrollToLine(Math.max(0, markers[i].line - 1));
          return;
        }
      }
      term.scrollToTop();
    }
  }, []);

  const isAtBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    // 2-line tolerance for near-bottom snap
    return term.buffer.active.viewportY >= term.buffer.active.baseY - BOTTOM_TOLERANCE;
  }, []);

  const isAtTop = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    return term.buffer.active.viewportY === 0;
  }, []);

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

  // Read current input from xterm.js buffer — authoritative, immediate,
  // independent of PTY input tracking. Strips the prompt prefix.
  // Supports both current (> + NBSP) and legacy (❯) Claude Code prompts.
  const getCurrentInput = useCallback((): string => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const y = buf.cursorY + buf.baseY;
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

  // Discard any pending write-batch chunks and cancel debounce timer.
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
    clearPending,
    focus,
    scrollToBottom,
    scrollToTop,
    scrollToLastUserMessage,
    isAtBottom,
    isAtTop,
    fit,
    getDimensions,
    getBufferText,
    getBufferTail,
    getCurrentInput,
    termRef,
  };
}
