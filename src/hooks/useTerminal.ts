import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme } from "../lib/theme";
import { dlog } from "../lib/debugLog";
import { startTraceSpan, traceSync } from "../lib/perfTrace";

export const TERMINAL_FONT_FAMILY = "'Pragmasevka', 'Roboto Mono', monospace";

const PROMPT_MARKER_NEW = ">\u00A0"; // > + NBSP — current Claude Code prompt

interface UseTerminalOptions {
  sessionId?: string | null;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

function escapePreview(text: string): string {
  return text
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .slice(0, 240);
}

function captureBufferState(term: Terminal) {
  const buf = term.buffer.active;
  return {
    cols: term.cols,
    rows: term.rows,
    cursorX: buf.cursorX,
    cursorY: buf.baseY + buf.cursorY,
    viewportY: buf.viewportY,
    baseY: buf.baseY,
    length: buf.length,
  };
}

export function useTerminal({ sessionId = null, onData, onResize }: UseTerminalOptions = {}) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachedRef = useRef(false);
  const pendingElRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const lastFitDimsRef = useRef<{ cols: number; rows: number } | null>(null);

  const webglRef = useRef<WebglAddon | null>(null);

  // Helper: open terminal in a DOM element (called once fonts + element are both ready)
  const openTerminal = useCallback((term: Terminal, el: HTMLDivElement) => {
    if (attachedRef.current) return;

    term.open(el);
    attachedRef.current = true;
    dlog("terminal", sessionIdRef.current, "terminal opened", "LOG", {
      event: "terminal.open",
      data: {
        ...captureBufferState(term),
      },
    });

    // [DF-06] WebGL renderer — if context is lost, fall back to canvas (no retry)
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        dlog("terminal", sessionIdRef.current, "webgl context lost", "WARN", {
          event: "terminal.webgl_context_lost",
          data: {},
        });
        webgl.dispose();
        webglRef.current = null;
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      dlog("terminal", sessionIdRef.current, "webgl renderer enabled", "DEBUG", {
        event: "terminal.webgl_enabled",
        data: {},
      });
    } catch {
      // WebGL not available — canvas fallback is automatic
      dlog("terminal", sessionIdRef.current, "webgl renderer unavailable; using canvas fallback", "DEBUG", {
        event: "terminal.webgl_unavailable",
        data: {},
      });
    }

    // Block xterm.js native paste handler — our custom Ctrl+V handler
    // in attachCustomKeyEventHandler handles paste via navigator.clipboard.
    // Without this, Tauri's permission dialog triggers a synthetic paste
    // event that xterm.js also handles, causing double-paste.
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true); // Capture phase — intercept before xterm.js

    // Observe container size changes
    const observer = new ResizeObserver(() => {
      try {
        const f = fitRef.current;
        if (!f) return;
        const dims = f.proposeDimensions();
        if (!dims || dims.rows <= 1) return;
        f.fit();
      } catch {}
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // Create terminal instance once fonts are ready
  useEffect(() => {
    let cancelled = false;
    let term: Terminal | null = null;
    const lifecycleDisposables: { dispose(): void }[] = [];

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

      lifecycleDisposables.push(
        term.onRender((range) => {
          dlog("terminal", sessionIdRef.current, "terminal render", "DEBUG", {
            event: "terminal.render",
            data: {
              start: range.start,
              end: range.end,
              buffer: captureBufferState(term!),
            },
          });
        }),
      );
      lifecycleDisposables.push(
        term.onScroll((viewportY) => {
          dlog("terminal", sessionIdRef.current, "terminal scroll", "DEBUG", {
            event: "terminal.scroll",
            data: {
              viewportY,
              buffer: captureBufferState(term!),
            },
          });
        }),
      );
      lifecycleDisposables.push(
        term.onResize(({ cols, rows }) => {
          dlog("terminal", sessionIdRef.current, "xterm resize", "DEBUG", {
            event: "terminal.xterm_resize",
            data: {
              cols,
              rows,
              buffer: captureBufferState(term!),
            },
          });
        }),
      );

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
            const selection = term!.getSelection();
            dlog("terminal", sessionIdRef.current, "terminal selection copied", "DEBUG", {
              event: "terminal.copy_selection",
              data: {
                length: selection.length,
                text: selection,
              },
            });
            navigator.clipboard.writeText(selection);
            term!.clearSelection();
            return false; // We handled it — don't send to PTY
          }
        }
        // Handle Ctrl+V paste — read clipboard and insert into terminal
        if (ev.ctrlKey && ev.key === "v" && ev.type === "keydown") {
          navigator.clipboard.readText().then((text) => {
            dlog("terminal", sessionIdRef.current, "terminal paste requested", "DEBUG", {
              event: "terminal.paste",
              data: {
                length: text.length,
                text,
              },
            });
            if (text) term!.paste(text);
          }).catch((err) => {
            dlog("terminal", sessionIdRef.current, `clipboard paste failed: ${err}`, "WARN", {
              event: "terminal.paste_failed",
              data: { error: String(err) },
            });
          });
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
              (ev.key === "D" || ev.key === "F" || ev.key === "G" || ev.key === "I" || ev.key === "R")) {
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
        openTerminal(term, pendingElRef.current);
      }
    })();

    return () => {
      cancelled = true;
      observerRef.current?.disconnect();
      lifecycleDisposables.forEach((d) => d.dispose());
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
      disposables.push(term.onData((data) => {
        dlog("terminal", sessionIdRef.current, "terminal input", "DEBUG", {
          event: "terminal.input",
          data: {
            length: data.length,
            text: data,
            preview: escapePreview(data),
          },
        });
        onData(data);
      }));
    }
    if (onResize) {
      disposables.push(term.onResize(({ cols, rows }) => {
        dlog("terminal", sessionIdRef.current, "terminal resize callback", "DEBUG", {
          event: "terminal.resize_callback",
          data: {
            cols,
            rows,
            buffer: captureBufferState(term),
          },
        });
        onResize(cols, rows);
      }));
    }

    return () => disposables.forEach((d) => d.dispose());
  }, [onData, onResize]);

  // Ref callback to attach terminal to a DOM element
  const attach = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    pendingElRef.current = el;
    dlog("terminal", sessionIdRef.current, "terminal attach requested", "DEBUG", {
      event: "terminal.attach",
      data: {
        alreadyAttached: attachedRef.current,
        elementWidth: el.clientWidth,
        elementHeight: el.clientHeight,
      },
    });

    const term = termRef.current;
    if (term && !attachedRef.current) {
      openTerminal(term, el);
    }
    // If term isn't ready yet, openTerminal will be called from the useEffect above
  }, [openTerminal]);

  const write = useCallback((data: string) => {
    const term = termRef.current;
    if (!term) return;
    const before = captureBufferState(term);
    const span = startTraceSpan("terminal.write_text_apply", {
      module: "terminal",
      sessionId: sessionIdRef.current,
      event: "terminal.write_text_perf",
      emitStart: false,
      warnAboveMs: 16,
      data: {
        length: data.length,
        preview: escapePreview(data),
      },
    });
    dlog("terminal", sessionIdRef.current, "terminal write(text)", "DEBUG", {
      event: "terminal.write_text",
      data: {
        length: data.length,
        text: data,
        preview: escapePreview(data),
        before,
      },
    });
    try {
      term.write(data, () => {
        span.end({
          after: captureBufferState(term),
        });
        dlog("terminal", sessionIdRef.current, "terminal write(text) applied", "DEBUG", {
          event: "terminal.write_text_applied",
          data: {
            length: data.length,
            after: captureBufferState(term),
          },
        });
      });
    } catch (err) {
      span.fail(err);
    }
  }, []);

  // [PT-16] [DF-03] Write raw bytes to terminal.
  const writeBytes = useCallback((data: Uint8Array) => {
    const term = termRef.current;
    if (!term) return;
    const text = new TextDecoder().decode(data);
    const before = captureBufferState(term);
    const span = startTraceSpan("terminal.write_bytes_apply", {
      module: "terminal",
      sessionId: sessionIdRef.current,
      event: "terminal.write_bytes_perf",
      emitStart: false,
      warnAboveMs: 16,
      data: {
        byteLength: data.byteLength,
        preview: escapePreview(text),
      },
    });
    dlog("terminal", sessionIdRef.current, "terminal write(bytes)", "DEBUG", {
      event: "terminal.write_bytes",
      data: {
        byteLength: data.byteLength,
        containsEscape: text.includes("\x1b"),
        containsCR: text.includes("\r"),
        containsLF: text.includes("\n"),
        text,
        preview: escapePreview(text),
        before,
      },
    });
    try {
      term.write(data, () => {
        span.end({
          after: captureBufferState(term),
        });
        dlog("terminal", sessionIdRef.current, "terminal write(bytes) applied", "DEBUG", {
          event: "terminal.write_bytes_applied",
          data: {
            byteLength: data.byteLength,
            after: captureBufferState(term),
          },
        });
      });
    } catch (err) {
      span.fail(err);
      dlog("terminal", sessionIdRef.current, `term.write error: ${err}`, "ERR");
    }
  }, []);

  const clear = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "terminal clear", "DEBUG", {
        event: "terminal.clear",
        data: {
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.clear();
  }, []);

  const focus = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "terminal focus", "DEBUG", {
        event: "terminal.focus",
        data: {
          buffer: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.focus();
  }, []);

  const scrollToBottom = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "scroll to bottom", "DEBUG", {
        event: "terminal.scroll_to_bottom",
        data: {
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.scrollToBottom();
  }, []);

  const scrollToTop = useCallback(() => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "scroll to top", "DEBUG", {
        event: "terminal.scroll_to_top",
        data: {
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.scrollToTop();
  }, []);

  const scrollToLine = useCallback((line: number) => {
    if (termRef.current) {
      dlog("terminal", sessionIdRef.current, "scroll to line", "DEBUG", {
        event: "terminal.scroll_to_line",
        data: {
          line,
          before: captureBufferState(termRef.current),
        },
      });
    }
    termRef.current?.scrollToLine(line);
  }, []);

  // [PT-08] 2-line tolerance for near-bottom snap detection
  const BOTTOM_TOLERANCE = 2;

  const isAtBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    const buf = term.buffer.active;
    return buf.baseY - buf.viewportY <= BOTTOM_TOLERANCE;
  }, []);

  const isAtTop = useCallback(() => {
    const term = termRef.current;
    if (!term) return true;
    return term.buffer.active.viewportY <= 0;
  }, []);

  // [PT-09] FitAddon dimension guard — skip fit if rows <= 1 (not laid out)
  const fit = useCallback(() => {
    traceSync("terminal.fit_apply", () => {
      try {
        const f = fitRef.current;
        const term = termRef.current;
        if (!f || !term) return;
        const dims = f.proposeDimensions();
        const before = { cols: term.cols, rows: term.rows };
        f.fit();
        const after = { cols: term.cols, rows: term.rows };
	  lastFitDimsRef.current = after;
	  dlog("terminal", sessionIdRef.current, "terminal fit", "DEBUG", {
		event: "terminal.fit",
		data: {
		  before,
		  after,
		  proposed: dims,
		},
	  });
      } catch {}
    }, {
      module: "terminal",
      sessionId: sessionIdRef.current,
      event: "terminal.fit_perf",
      warnAboveMs: 8,
      data: {},
    });
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
    const promptIdx = text.lastIndexOf(PROMPT_MARKER_NEW);
    if (promptIdx >= 0) {
      // Strip focus event remnants ([I = focus in, [O = focus out) that leak into buffer text
      return text.slice(promptIdx + 2).replace(/\[[OI]/g, "").trimEnd();
    }
    return "";
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
    isAtBottom,
    isAtTop,
    fit,
    getDimensions,
    getBufferText,
    getCurrentInput,
    termRef,
    webglRef,
  };
}
