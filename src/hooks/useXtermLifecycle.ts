import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readText as clipboardReadText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { getTerminalTheme } from "../lib/theme";
import { dlog, shouldRecordDebugLog } from "../lib/debugLog";
import { traceSync } from "../lib/perfTrace";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { getResumeId } from "../lib/claude";
import { IS_WINDOWS, IS_LINUX } from "../lib/paths";
import { createPathLinkProvider } from "../lib/terminalPathLinks";
import {
  classifyTerminalKey,
  isTerminalModalOpen,
} from "../lib/terminalKeyShortcuts";
import { resetTerminalWriteQueue, type TerminalWriteQueue } from "../lib/terminalWriteQueue";
import {
  captureBufferState,
  escapePreview,
  isElementVisible,
  TERMINAL_FONT_FAMILY,
  XTVERSION_REPLY,
} from "./terminalShared";

interface UseXtermLifecycleParams {
  cwdRef: MutableRefObject<string | null>;
  enableWebgl: boolean;
  instanceKey: number;
  onDataRef: MutableRefObject<((data: string) => void) | undefined>;
  scrollback: number;
  sessionIdRef: MutableRefObject<string | null>;
  visible: boolean;
  visibleRef: MutableRefObject<boolean>;
  writeInFlightRef: MutableRefObject<boolean>;
  writeQueueRef: MutableRefObject<TerminalWriteQueue>;
}

export function useXtermLifecycle({
  cwdRef,
  enableWebgl,
  instanceKey,
  onDataRef,
  scrollback,
  sessionIdRef,
  visible,
  visibleRef,
  writeInFlightRef,
  writeQueueRef,
}: UseXtermLifecycleParams) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachedRef = useRef(false);
  const pendingElRef = useRef<HTMLDivElement | null>(null);
  const pasteBlockCleanupRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [termGeneration, setTermGeneration] = useState(0);

  const webglRef = useRef<WebglAddon | null>(null);
  const webLinksAddonRef = useRef<WebLinksAddon | null>(null);
  const unicode11AddonRef = useRef<Unicode11Addon | null>(null);
  const pathLinkDisposableRef = useRef<{ dispose(): void } | null>(null);

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
  }, [sessionIdRef]);

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

    if (enableWebgl) {
      // [DF-06] WebGL renderer - if context is lost, fall back to canvas (no retry)
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
        // WebGL not available - canvas fallback is automatic
        dlog("terminal", sessionIdRef.current, "webgl renderer unavailable; using canvas fallback", "DEBUG", {
          event: "terminal.webgl_unavailable",
          data: {},
        });
      }
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
    // paste. macOS left alone - native paste handling works.
    pasteBlockCleanupRef.current?.();
    if (IS_WINDOWS || IS_LINUX) {
      const handlePaste = (e: ClipboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      el.addEventListener("paste", handlePaste, true); // Capture phase - intercept before xterm.js
      pasteBlockCleanupRef.current = () => {
        el.removeEventListener("paste", handlePaste, true);
      };
    } else {
      pasteBlockCleanupRef.current = null;
    }

    fit();
    return true;
  }, [cwdRef, enableWebgl, fit, sessionIdRef]);

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

      // [PT-06] Fixed scrollback buffer per CLI - no dynamic resizing.
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
          if (buf.type === "alternate") {
            term!.write("\x1b[?1003h\x1b[?1006h");
          } else {
            term!.write("\x1b[?1003l\x1b[?1006l");
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
          // CLI writes during VTUI init. The XTVERSION probe (CSI > 0 q) is the
          // first deterministic signal that fires AFTER the CLI's VTUI is fully
          // rendered and ready to consume mouse reports. Enable tracking here
          // instead of at spawn to avoid SGR motion reports flooding CLI stdin
          // before the VTUI mouse handler is active.
          term!.write("\x1b[?1003h\x1b[?1006h");
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
        const decision = classifyTerminalKey(ev, {
          isLinux: IS_LINUX,
          modalOpen: isTerminalModalOpen(),
          hasSelection: term!.hasSelection(),
        });

        if (decision.kind === "passthrough") return true;
        if (decision.kind === "swallow") return false;

        if (decision.kind === "send") {
          dlog("terminal", sessionIdRef.current, "terminal key sequence override", "DEBUG", {
            event: "terminal.key_sequence_override",
            data: {
              key: ev.key,
              code: ev.code,
              sequence: decision.data,
              preview: escapePreview(decision.data),
            },
          });
          onDataRef.current?.(decision.data);
          return false;
        }

        switch (decision.action) {
          case "copySelection":
            if (term!.hasSelection()) {
              const selection = term!.getSelection();
              dlog("terminal", sessionIdRef.current, "terminal selection copied", "DEBUG", {
                event: "terminal.copy_selection",
                data: { length: selection.length, text: selection },
              });
              navigator.clipboard.writeText(selection);
              term!.clearSelection();
            }
            return false;

          case "pasteClipboard":
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
            return false;

          case "scrollTop":
            term!.scrollToTop();
            return false;

          case "scrollBottom":
            term!.scrollToBottom();
            return false;
        }
        return false;
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
  }, [
    enableWebgl,
    instanceKey,
    onDataRef,
    openTerminal,
    scrollback,
    sessionIdRef,
    visibleRef,
    writeInFlightRef,
    writeQueueRef,
  ]);

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
  }, [fit, openTerminal, sessionIdRef]);

  return {
    attach,
    fit,
    ready,
    termGeneration,
    termRef,
    webglRef,
  };
}
