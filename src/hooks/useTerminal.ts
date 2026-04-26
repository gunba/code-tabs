import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { readText as clipboardReadText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { getTerminalTheme } from "../lib/theme";
import { dlog, shouldRecordDebugLog } from "../lib/debugLog";
import { startTraceSpan, traceSync } from "../lib/perfTrace";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { getResumeId } from "../lib/claude";
import { IS_WINDOWS, IS_LINUX } from "../lib/paths";
import { createPathLinkProvider } from "../lib/terminalPathLinks";
import {
  createTerminalWriteQueue,
  enqueueTerminalWrite,
  getTerminalWriteQueueDepth,
  resetTerminalWriteQueue,
  takeTerminalWriteBatch,
  type TerminalWriteQueue,
} from "../lib/terminalWriteQueue";

export const TERMINAL_FONT_FAMILY = "'Pragmasevka', 'Roboto Mono', 'ClaudeEmoji', monospace";

// [DF-05] xterm.js 6.0 with DEC 2026 synchronized output — coalesces ink BSU/ESU diff frames so rapid TUI writes don't flash partial buffers.
const XTVERSION_REPLY = "\x1bP>|xterm.js(6.0.0)\x1b\\";
// [TA-12] SHIFT_ENTER_SEQUENCE: kitty-protocol \x1b[13;2u; getTerminalKeySequenceOverride intercepts Shift+Enter before xterm default
export const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const terminalOutputDecoder = new TextDecoder();

type TerminalKeyEventLike = Pick<KeyboardEvent, "type" | "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">;

export function getTerminalKeySequenceOverride(ev: TerminalKeyEventLike): string | null {
  const isEnter = ev.key === "Enter" || ev.code === "Enter" || ev.code === "NumpadEnter";
  if (
    ev.type === "keydown" &&
    isEnter &&
    ev.shiftKey &&
    !ev.ctrlKey &&
    !ev.altKey &&
    !ev.metaKey
  ) {
    return SHIFT_ENTER_SEQUENCE;
  }
  return null;
}

interface UseTerminalOptions {
  sessionId?: string | null;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  instanceKey?: number;
  cwd?: string | null;
  scrollback?: number;
  enableWebgl?: boolean;
  visible?: boolean;
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

function isElementVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function useTerminal({
  sessionId = null,
  onData,
  onResize,
  instanceKey = 0,
  cwd = null,
  scrollback = 100_000,
  enableWebgl = true,
  visible = true,
}: UseTerminalOptions = {}) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachedRef = useRef(false);
  const pendingElRef = useRef<HTMLDivElement | null>(null);
  const pasteBlockCleanupRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const onDataRef = useRef<typeof onData>(onData);
  onDataRef.current = onData;
  const cwdRef = useRef<string | null>(cwd);
  cwdRef.current = cwd;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [ready, setReady] = useState(false);
  const [termGeneration, setTermGeneration] = useState(0);
  const writeQueueRef = useRef<TerminalWriteQueue>(createTerminalWriteQueue());
  const writeInFlightRef = useRef(false);

  const webglRef = useRef<WebglAddon | null>(null);
  const webLinksAddonRef = useRef<WebLinksAddon | null>(null);
  const unicode11AddonRef = useRef<Unicode11Addon | null>(null);
  const pathLinkDisposableRef = useRef<{ dispose(): void } | null>(null);

  const enableWebglRenderer = useCallback((term: Terminal) => {
    if (!enableWebgl || webglRef.current) return;
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
  }, [enableWebgl]);

  const disposeWebglRenderer = useCallback((event: string, message: string) => {
    if (!webglRef.current) return;
    webglRef.current.dispose();
    webglRef.current = null;
    dlog("terminal", sessionIdRef.current, message, "DEBUG", {
      event,
      data: {},
    });
  }, []);

  // [DF-10] FitAddon.fit() is called bare (no try/catch) so resize errors propagate to the caller.
  const fit = useCallback(() => {
    return traceSync("terminal.fit_apply", () => {
      if (!attachedRef.current) return false;
      const f = fitRef.current;
      const term = termRef.current;
      if (!f || !term) return false;
      const before = { cols: term.cols, rows: term.rows };
      f.fit();
      const after = { cols: term.cols, rows: term.rows };
      dlog("terminal", sessionIdRef.current, "terminal fit", "DEBUG", {
        event: "terminal.fit",
        data: {
          before,
          after,
        },
      });
      const isReady = after.cols > 0 && after.rows > 0;
      setReady(isReady);
      return isReady;
    }, {
      module: "terminal",
      sessionId: sessionIdRef.current,
      event: "terminal.fit_perf",
      warnAboveMs: 8,
      data: {},
    });
  }, []);

  // Helper: open terminal in a DOM element (called once fonts + element are both ready)
  const openTerminal = useCallback((term: Terminal, el: HTMLDivElement) => {
    if (attachedRef.current || !isElementVisible(el)) return false;

    term.open(el);
    attachedRef.current = true;
    setReady(false);
    dlog("terminal", sessionIdRef.current, "terminal opened", "LOG", {
      event: "terminal.open",
      data: {
        ...captureBufferState(term),
      },
    });

    if (enableWebgl && visibleRef.current) {
      enableWebglRenderer(term);
    } else if (enableWebgl) {
      dlog("terminal", sessionIdRef.current, "webgl renderer deferred while hidden", "DEBUG", {
        event: "terminal.webgl_deferred_hidden",
        data: {},
      });
    } else {
      dlog("terminal", sessionIdRef.current, "webgl renderer disabled", "DEBUG", {
        event: "terminal.webgl_disabled",
        data: {},
      });
    }

    // [DF-11] xterm addons loaded on open: web-links, path links, unicode11 (each in try/catch); unicode11 sets activeVersion="11"
    try {
      const webLinks = new WebLinksAddon((event, uri) => {
        const reveal = event.ctrlKey || event.metaKey;
        invoke(reveal ? "reveal_in_file_manager" : "shell_open", { path: uri }).catch((e) => {
          dlog("terminal", sessionIdRef.current, `web link open failed: ${e}`, "WARN", {
            event: "terminal.web_link_open_failed",
            data: { uri, reveal, error: String(e) },
          });
        });
      });
      term.loadAddon(webLinks);
      webLinksAddonRef.current = webLinks;
      dlog("terminal", sessionIdRef.current, "web-links addon enabled", "DEBUG", {
        event: "terminal.web_links_enabled",
        data: {},
      });
    } catch {
      dlog("terminal", sessionIdRef.current, "web-links addon unavailable", "DEBUG", {
        event: "terminal.web_links_unavailable",
        data: {},
      });
    }

    try {
      pathLinkDisposableRef.current?.dispose();
      const { provider } = createPathLinkProvider({
        term,
        getCwd: () => cwdRef.current,
      });
      pathLinkDisposableRef.current = term.registerLinkProvider(provider);
      dlog("terminal", sessionIdRef.current, "path link provider enabled", "DEBUG", {
        event: "terminal.path_link_provider_enabled",
        data: {},
      });
    } catch {
      dlog("terminal", sessionIdRef.current, "path link provider unavailable", "DEBUG", {
        event: "terminal.path_link_provider_unavailable",
        data: {},
      });
    }

    try {
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";
      unicode11AddonRef.current = unicode11;
      dlog("terminal", sessionIdRef.current, "unicode11 addon enabled", "DEBUG", {
        event: "terminal.unicode11_enabled",
        data: {},
      });
    } catch {
      dlog("terminal", sessionIdRef.current, "unicode11 addon unavailable", "DEBUG", {
        event: "terminal.unicode11_unavailable",
        data: {},
      });
    }

    // [KB-12] Platform-gated paste blocker: capture-phase preventDefault on Windows + Linux.
    // Windows: avoids Tauri permission-dialog double-paste. Linux: ensures Ctrl+V sends ^V to the
    // PTY cleanly so Claude Code's native image-paste handler (wl-paste/xclip) runs. Linux text
    // paste uses Ctrl+Shift+V, which reads via Tauri's clipboard plugin and writes via bracketed
    // paste. macOS left alone — native paste handling works.
    pasteBlockCleanupRef.current?.();
    if (IS_WINDOWS || IS_LINUX) {
      const handlePaste = (e: ClipboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      el.addEventListener("paste", handlePaste, true); // Capture phase — intercept before xterm.js
      pasteBlockCleanupRef.current = () => {
        el.removeEventListener("paste", handlePaste, true);
      };
    } else {
      pasteBlockCleanupRef.current = null;
    }

    fit();
    return true;
  }, [enableWebgl, enableWebglRenderer, fit]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !attachedRef.current || !enableWebgl) return;
    if (visible) {
      enableWebglRenderer(term);
    } else {
      disposeWebglRenderer("terminal.webgl_disposed_hidden", "webgl renderer disposed while hidden");
    }
  }, [disposeWebglRenderer, enableWebgl, enableWebglRenderer, visible]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorBlink = visible;
  }, [visible]);

  // Create terminal instance once fonts are ready
  useEffect(() => {
    let cancelled = false;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    const lifecycleDisposables: { dispose(): void }[] = [];
    setReady(false);

    (async () => {
      // Wait for fonts so xterm.js measures correct cell dimensions at open()
      await document.fonts.ready;
      if (cancelled) return;

      // [PT-06] Fixed scrollback buffer per CLI — no dynamic resizing.
      // Codex uses normal scrollback more heavily than Claude's alternate-screen TUI,
      // so its cap is intentionally lower to avoid long-session xterm memory blowups.
      term = new Terminal({
        cursorBlink: visibleRef.current,
        fontSize: 14,
        fontFamily: TERMINAL_FONT_FAMILY,
        theme: getTerminalTheme(),
        scrollback,
      });

      lifecycleDisposables.push(
        term.onRender((range) => {
          const sid = sessionIdRef.current;
          if (!shouldRecordDebugLog("DEBUG", sid)) return;
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
          const sid = sessionIdRef.current;
          if (!shouldRecordDebugLog("DEBUG", sid)) return;
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
          const sid = sessionIdRef.current;
          if (!shouldRecordDebugLog("DEBUG", sid)) return;
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
      // ConPTY passes through alt-screen switch (\e[?1049h) but not mouse
      // tracking modes. Tie mouse tracking to buffer lifecycle so it enables
      // on alt-screen entry and disables on exit.
      lifecycleDisposables.push(
        term.buffer.onBufferChange((buf) => {
          if (buf.type === 'alternate') {
            term!.write('\x1b[?1003h\x1b[?1006h');
          } else {
            term!.write('\x1b[?1003l\x1b[?1006l');
          }
        }),
      );
      lifecycleDisposables.push(
        term.parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
          if (params.length !== 1 || params[0] !== 0) return false;
          dlog("terminal", sessionIdRef.current, "terminal identity query", "DEBUG", {
            event: "terminal.identity_query",
            data: {
              params,
              reply: XTVERSION_REPLY,
            },
          });
          // ConPTY strips DEC mouse tracking sequences (\e[?1003h etc.) that the
          // CLI writes during VTUI init.  The XTVERSION probe (CSI > 0 q) is the
          // first deterministic signal that fires AFTER the CLI's VTUI is fully
          // rendered and ready to consume mouse reports.  Enable tracking here
          // instead of at spawn to avoid SGR motion reports flooding CLI stdin
          // before the VTUI mouse handler is active.
          term!.write('\x1b[?1003h\x1b[?1006h');
          onDataRef.current?.(XTVERSION_REPLY);
          return true;
        }),
      );
      // [TA-10] OSC 0 auto-rename: Linux/macOS Claude Code subagents emit title via OSC 0;
      // Windows uses process.title and does not fire this path. Strip Claude Code's state-prefix
      // chars (spinners, bullets) and skip the "Claude Code" default placeholder so tab names
      // reflect only the Haiku-generated session title.
      lifecycleDisposables.push(
        term.onTitleChange((rawTitle) => {
          const title = rawTitle.replace(/^[^\p{L}\p{N}]+/u, "").trim();
          const sid = sessionIdRef.current;
          dlog("terminal", sid, "terminal title changed", "DEBUG", {
            event: "terminal.title_change",
            data: { rawTitle, title },
          });
          if (!sid || !title || title === "Code Tabs" || title.startsWith("Claude Code") || title.toLowerCase() === "claude") return;
          const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
          if (session && title !== session.name) {
            useSessionStore.getState().renameSession(sid, title);
            useSettingsStore.getState().setSessionName(getResumeId(session), title);
          }
        }),
      );

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Custom key handlers: Ctrl+C copy, Ctrl+V paste
      // xterm.js convention: return false = "I handled this, suppress default"
      // return true = "let xterm.js handle normally"
      term.attachCustomKeyEventHandler((ev) => {
        // Block all input when a modal overlay is open
        if (document.querySelector('.launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay, .inspector-overlay')) {
          return false; // Suppress — modal is open
        }
        const keySequenceOverride = getTerminalKeySequenceOverride(ev);
        if (keySequenceOverride !== null) {
          dlog("terminal", sessionIdRef.current, "terminal key sequence override", "DEBUG", {
            event: "terminal.key_sequence_override",
            data: {
              key: ev.key,
              code: ev.code,
              sequence: keySequenceOverride,
              preview: escapePreview(keySequenceOverride),
            },
          });
          onDataRef.current?.(keySequenceOverride);
          return false;
        }
        // Ctrl+Shift+C — Linux primary copy shortcut; copies selection if present.
        // Always swallow to prevent xterm sending \x03 twice on Linux.
        if (ev.ctrlKey && ev.shiftKey && (ev.key === "c" || ev.key === "C") && ev.type === "keydown") {
          if (term!.hasSelection()) {
            const selection = term!.getSelection();
            dlog("terminal", sessionIdRef.current, "terminal selection copied (ctrl+shift+c)", "DEBUG", {
              event: "terminal.copy_selection",
              data: { length: selection.length, text: selection },
            });
            navigator.clipboard.writeText(selection);
            term!.clearSelection();
          }
          return false;
        }
        if (ev.ctrlKey && !ev.shiftKey && ev.key === "c" && ev.type === "keydown") {
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
        // Ctrl+Shift+V — cross-platform text paste. Reads via Tauri clipboard plugin
        // (navigator.clipboard.readText silently fails on webkit2gtk/Wayland). Text is
        // delivered to the PTY via xterm's bracketed paste, which Claude Code's TUI reads.
        if (ev.ctrlKey && ev.shiftKey && (ev.key === "v" || ev.key === "V") && ev.type === "keydown") {
          clipboardReadText().then((text) => {
            dlog("terminal", sessionIdRef.current, "terminal paste requested (ctrl+shift+v)", "DEBUG", {
              event: "terminal.paste",
              data: { length: text?.length ?? 0, text },
            });
            if (text) term!.paste(text);
          }).catch((err) => {
            dlog("terminal", sessionIdRef.current, `clipboard paste failed: ${err}`, "WARN", {
              event: "terminal.paste_failed",
              data: { error: String(err) },
            });
          });
          return false;
        }
        // Handle Ctrl+V paste — read clipboard and insert into terminal
        if (ev.ctrlKey && !ev.shiftKey && ev.key === "v" && ev.type === "keydown") {
          // Linux: let xterm send ^V to PTY so Claude Code's chat:imagePaste keybind runs
          // its native wl-paste image read (text paste on Linux goes through Ctrl+Shift+V).
          if (IS_LINUX) return true;
          clipboardReadText().then((text) => {
            dlog("terminal", sessionIdRef.current, "terminal paste requested", "DEBUG", {
              event: "terminal.paste",
              data: {
                length: text?.length ?? 0,
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
      fitRef.current = fitAddon;
      setTermGeneration((g) => g + 1);

      // If attach was called before WASM was ready, open now
      const pendingEl = pendingElRef.current;
      if (pendingEl && isElementVisible(pendingEl)) {
        openTerminal(term, pendingEl);
      }
    })();

    return () => {
      cancelled = true;
      observerRef.current?.disconnect();
      observerRef.current = null;
      pasteBlockCleanupRef.current?.();
      pasteBlockCleanupRef.current = null;
      lifecycleDisposables.forEach((d) => d.dispose());
      resetTerminalWriteQueue(writeQueueRef.current);
      writeInFlightRef.current = false;
      webglRef.current?.dispose();
      webglRef.current = null;
      webLinksAddonRef.current?.dispose();
      webLinksAddonRef.current = null;
      pathLinkDisposableRef.current?.dispose();
      pathLinkDisposableRef.current = null;
      unicode11AddonRef.current?.dispose();
      unicode11AddonRef.current = null;
      term?.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitAddon && fitRef.current === fitAddon) fitRef.current = null;
      attachedRef.current = false;
      setReady(false);
    };
  }, [enableWebgl, fit, instanceKey, openTerminal, scrollback]);

  // Wire up onData/onResize handlers (update when callbacks change)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposables: { dispose(): void }[] = [];

    if (onData) {
      disposables.push(term.onData((data) => {
        const sid = sessionIdRef.current;
        if (shouldRecordDebugLog("DEBUG", sid)) {
          dlog("terminal", sid, "terminal input", "DEBUG", {
            event: "terminal.input",
            data: {
              length: data.length,
              text: data,
              preview: escapePreview(data),
            },
          });
        }
        onData(data);
      }));
    }
    if (onResize) {
      disposables.push(term.onResize(({ cols, rows }) => {
        const sid = sessionIdRef.current;
        if (shouldRecordDebugLog("DEBUG", sid)) {
          dlog("terminal", sid, "terminal resize callback", "DEBUG", {
            event: "terminal.resize_callback",
            data: {
              cols,
              rows,
              buffer: captureBufferState(term),
            },
          });
        }
        onResize(cols, rows);
      }));
    }

    return () => disposables.forEach((d) => d.dispose());
  }, [onData, onResize, termGeneration]);

  // Ref callback to attach terminal to a DOM element
  const attach = useCallback((el: HTMLDivElement | null) => {
    pendingElRef.current = el;
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    dlog("terminal", sessionIdRef.current, "terminal attach requested", "DEBUG", {
      event: "terminal.attach",
      data: {
        alreadyAttached: attachedRef.current,
        elementWidth: el.clientWidth,
        elementHeight: el.clientHeight,
      },
    });

    const observer = new ResizeObserver(() => {
      const term = termRef.current;
      if (!term) return;
      if (!attachedRef.current) {
        openTerminal(term, el);
        return;
      }
      fit();
    });
    observer.observe(el);
    observerRef.current = observer;

    const term = termRef.current;
    if (term && !attachedRef.current) {
      openTerminal(term, el);
    }
    // If term isn't ready yet, openTerminal will be called from the useEffect above
  }, [fit, openTerminal]);

  const flushWriteQueue = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // Hidden tabs keep raw output queued; xterm parsing/rendering catches up on activation.
    if (!visibleRef.current) return;
    if (writeInFlightRef.current) return;
    const queuedChunks = getTerminalWriteQueueDepth(writeQueueRef.current);
    const batch = takeTerminalWriteBatch(writeQueueRef.current);
    if (!batch) return;

    const sid = sessionIdRef.current;
    const isBytes = batch.data instanceof Uint8Array;
    const debug = shouldRecordDebugLog("DEBUG", sid);
    let decoded: string | null = null;
    const getText = () => {
      if (typeof batch.data === "string") return batch.data;
      if (decoded === null) decoded = terminalOutputDecoder.decode(batch.data);
      return decoded;
    };
    const span = startTraceSpan(isBytes ? "terminal.write_bytes_apply" : "terminal.write_text_apply", {
      module: "terminal",
      sessionId: sid,
      event: isBytes ? "terminal.write_bytes_perf" : "terminal.write_text_perf",
      emitStart: false,
      warnAboveMs: 16,
      data: () => ({
        chunkCount: batch.chunkCount,
        queueDepth: queuedChunks,
        ...(isBytes
          ? { byteLength: batch.size, preview: escapePreview(getText()) }
          : { length: batch.size, preview: escapePreview(getText()) }),
      }),
    });
    if (debug) {
      const text = getText();
      dlog("terminal", sid, isBytes ? "terminal write(bytes) batch" : "terminal write(text) batch", "DEBUG", {
        event: isBytes ? "terminal.write_bytes_batch" : "terminal.write_text_batch",
        data: {
          chunkCount: batch.chunkCount,
          queueDepth: queuedChunks,
          ...(isBytes
            ? {
                byteLength: batch.size,
                containsEscape: text.includes("\x1b"),
                containsCR: text.includes("\r"),
                containsLF: text.includes("\n"),
              }
            : { length: batch.size }),
          text,
          preview: escapePreview(text),
        },
      });
    }
    writeInFlightRef.current = true;
    try {
      term.write(batch.data, () => {
        if (termRef.current !== term) return;
        span.end(() => ({
          after: captureBufferState(term),
        }));
        if (debug) {
          dlog("terminal", sid, isBytes ? "terminal write(bytes) applied" : "terminal write(text) applied", "DEBUG", {
            event: isBytes ? "terminal.write_bytes_applied" : "terminal.write_text_applied",
            data: {
              chunkCount: batch.chunkCount,
              ...(isBytes ? { byteLength: batch.size } : { length: batch.size }),
              after: captureBufferState(term),
            },
          });
        }
        writeInFlightRef.current = false;
        flushWriteQueue();
      });
    } catch (err) {
      span.fail(err);
      writeInFlightRef.current = false;
      dlog("terminal", sid, `term.write error: ${err}`, "ERR");
      flushWriteQueue();
    }
  }, []);

  useEffect(() => {
    if (visible) {
      flushWriteQueue();
    }
  }, [flushWriteQueue, visible]);

  const write = useCallback((data: string) => {
    if (!termRef.current) return;
    const sid = sessionIdRef.current;
    if (shouldRecordDebugLog("DEBUG", sid)) {
      dlog("terminal", sid, "terminal write(text) queued", "DEBUG", {
        event: "terminal.write_text_queued",
        data: {
          length: data.length,
          preview: escapePreview(data),
          queueDepth: getTerminalWriteQueueDepth(writeQueueRef.current),
        },
      });
    }
    enqueueTerminalWrite(writeQueueRef.current, data);
    flushWriteQueue();
  }, [flushWriteQueue]);

  // [PT-16] [DF-03] Write raw bytes to terminal.
  const writeBytes = useCallback((data: Uint8Array) => {
    if (!termRef.current) return;
    const sid = sessionIdRef.current;
    if (shouldRecordDebugLog("DEBUG", sid)) {
      let text: string | null = null;
      const getText = () => text ??= terminalOutputDecoder.decode(data);
      const decoded = getText();
      dlog("terminal", sid, "terminal write(bytes) queued", "DEBUG", {
        event: "terminal.write_bytes_queued",
        data: {
          byteLength: data.byteLength,
          containsEscape: decoded.includes("\x1b"),
          containsCR: decoded.includes("\r"),
          containsLF: decoded.includes("\n"),
          text: decoded,
          preview: escapePreview(decoded),
          queueDepth: getTerminalWriteQueueDepth(writeQueueRef.current),
        },
      });
    }
    enqueueTerminalWrite(writeQueueRef.current, data);
    flushWriteQueue();
  }, [flushWriteQueue]);

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
    scrollToTop,
    scrollToLine,
    isAtBottom,
    isAtTop,
    fit,
    getDimensions,
    getBufferText,
    termRef,
    webglRef,
    ready,
    termGeneration,
  };
}
