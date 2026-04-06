import { useEffect, useRef, useCallback, useState } from "react";
import { dlog } from "../lib/debugLog";

/** Fast retry interval for initial connection (Bun debugger may not be ready yet). */
const INITIAL_RETRY_MS = 100;
/** Max fast-retry attempts before giving up (~3s total). */
const MAX_INITIAL_RETRIES = 30;
/** Backoff delays for reconnection after an established connection drops. */
const RECONNECT_DELAYS = [2000, 4000, 8000];

// [SI-02] Inspector connects immediately; retries 30x at 100ms, then backoff [2s, 4s, 8s]
// [IN-12] WebSocket lifecycle only: connect, Runtime.evaluate, retry, disconnect. No state derivation.
/**
 * Manages the BUN_INSPECT WebSocket connection lifecycle.
 * Used only for Runtime.evaluate (hook injection + category toggling).
 * TAP event data arrives via a separate TCP channel, not this WebSocket.
 */
export function useInspectorConnection(
  sessionId: string | null,
  port: number | null,
  reconnectKey?: number
): {
  connected: boolean;
  disconnect: () => void;
  wsSend: (method: string, params?: Record<string, unknown>) => number;
} {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const everConnectedRef = useRef(false); // distinguishes initial connect vs reconnect
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgIdRef = useRef(1);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const summarizeExpression = (expression: unknown): string => {
    if (typeof expression !== "string") return "";
    return expression.replace(/\s+/g, " ").slice(0, 180);
  };

  // Send a WebSocket message with auto-incrementing id
  const wsSend = useCallback((method: string, params?: Record<string, unknown>): number => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return -1;
    const id = msgIdRef.current++;
    dlog("inspector", sessionIdRef.current, `ws send ${method}#${id}`, "DEBUG", {
      event: "inspector.ws_send",
      data: {
        id,
        method,
        expression: summarizeExpression(params?.expression),
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
    return id;
  }, []);

  // Connect to inspector WebSocket
  const connectRef = useRef<(port: number) => void>(() => {});
  const connect = useCallback((wsPort: number) => {
    const url = `ws://127.0.0.1:${wsPort}/0`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      dlog("inspector", sessionIdRef.current, `connected port=${wsPort}`, "LOG", {
        event: "inspector.connected",
        data: { port: wsPort },
      });
      retryCountRef.current = 0;
      everConnectedRef.current = true;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Log Runtime.evaluate exceptions
        if (msg.result?.exceptionDetails) {
          dlog("inspector", sessionIdRef.current, `evaluation error: ${msg.result.exceptionDetails.text || msg.result.exceptionDetails.exception?.description}`, "WARN", {
            event: "inspector.evaluate_error",
            data: {
              id: msg.id ?? null,
            },
          });
        }

        // Log Runtime.evaluate results that contain diagnostic info (tap TCP connection state)
        const val = msg.result?.result?.value;
        if (typeof val === "string" && val.includes('"connected"')) {
          dlog("inspector", sessionIdRef.current, `tap-diag: ${val}`, "LOG", {
            event: "inspector.tap_diag",
            data: { value: val },
          });
        }
      } catch {
        // Invalid message — skip
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      if (!sessionIdRef.current) return;

      if (!everConnectedRef.current) {
        // Initial connection: Bun debugger not ready yet — retry fast
        if (retryCountRef.current < MAX_INITIAL_RETRIES) {
          retryCountRef.current++;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (sessionIdRef.current) connectRef.current(wsPort);
          }, INITIAL_RETRY_MS);
        } else {
          dlog("inspector", sessionIdRef.current, `gave up connecting after ${MAX_INITIAL_RETRIES} attempts`, "WARN", {
            event: "inspector.connect_give_up",
            data: { attempts: MAX_INITIAL_RETRIES, port: wsPort },
          });
        }
      } else {
        // Reconnection after established connection dropped — backoff
        dlog("inspector", sessionIdRef.current, `disconnected port=${wsPort}`, "LOG", {
          event: "inspector.disconnected",
          data: { port: wsPort },
        });
        const maxReconnect = RECONNECT_DELAYS.length;
        if (retryCountRef.current < maxReconnect) {
          const delay = RECONNECT_DELAYS[retryCountRef.current];
          retryCountRef.current++;
          dlog("inspector", sessionIdRef.current, `reconnecting attempt=${retryCountRef.current}/${maxReconnect} delay=${delay}ms`, "DEBUG", {
            event: "inspector.reconnect_scheduled",
            data: { attempt: retryCountRef.current, maxReconnect, delayMs: delay, port: wsPort },
          });
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (sessionIdRef.current) connectRef.current(wsPort);
          }, delay);
        }
      }
    };

    ws.onerror = () => {
      // onclose fires after onerror — reconnection handled there
    };
  }, [wsSend]);
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null; // Prevent reconnection
      ws.close();
      wsRef.current = null;
    }
    setConnected(false);
    retryCountRef.current = 0;
    everConnectedRef.current = false;
    msgIdRef.current = 1;
  }, []);

  // Lifecycle: connect immediately when port is available
  useEffect(() => {
    if (!sessionId || !port) return;

    retryCountRef.current = 0;
    everConnectedRef.current = false;
    connect(port);

    return () => {
      disconnect();
    };
  }, [sessionId, port, connect, disconnect, reconnectKey]);

  return { connected, disconnect, wsSend };
}
