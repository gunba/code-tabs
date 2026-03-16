import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getXtermTheme } from "../lib/theme";

interface UseTerminalOptions {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function useTerminal({ onData, onResize }: UseTerminalOptions = {}) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachedRef = useRef(false);

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
      scrollback: 10000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    // Custom key handlers: Ctrl+C copy, Ctrl+V paste
    term.attachCustomKeyEventHandler((ev) => {
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
      return true; // Let it through
    });

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      observerRef.current?.disconnect();
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
      disposables.push(term.onData(onData));
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

    try {
      term.loadAddon(new WebglAddon());
    } catch {}

    try {
      fit.fit();
    } catch {}

    // Observe container size changes
    const observer = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
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

    const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;

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

  const isAtBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    return term.buffer.active.viewportY >= term.buffer.active.baseY;
  }, []);

  const fit = useCallback(() => {
    try {
      fitRef.current?.fit();
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

  return {
    attach,
    write,
    writeBytes,
    clear,
    focus,
    scrollToBottom,
    isAtBottom,
    fit,
    getDimensions,
    getBufferText,
    termRef,
  };
}
