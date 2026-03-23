/**
 * Port allocator for BUN_INSPECT WebSocket connections.
 * Each session gets a unique port verified free at the OS level.
 * Range: 6400-6499 (100 ports, well above typical concurrent session count).
 */
import { invoke } from "@tauri-apps/api/core";

const PORT_MIN = 6400;
const PORT_MAX = 6499;
let nextPort = PORT_MIN;

/**
 * Allocate a free inspector port. Skips ports held by active sessions
 * and probes the OS via TcpListener::bind to guarantee availability.
 * Throws if all 100 ports are occupied.
 */
export async function allocateInspectorPort(): Promise<number> {
  const usedPorts = new Set(portRegistry.values());
  const rangeSize = PORT_MAX - PORT_MIN + 1;

  for (let i = 0; i < rangeSize; i++) {
    const port = nextPort;
    nextPort = nextPort >= PORT_MAX ? PORT_MIN : nextPort + 1;

    if (usedPorts.has(port)) continue;

    const available = await invoke<boolean>("check_port_available", { port });
    if (available) return port;
  }

  throw new Error("No free inspector ports in range 6400-6499");
}

/** Registry mapping app session IDs to their BUN_INSPECT ports. */
const portRegistry = new Map<string, number>();

export function registerInspectorPort(sessionId: string, port: number): void {
  portRegistry.set(sessionId, port);
}

export function unregisterInspectorPort(sessionId: string): void {
  portRegistry.delete(sessionId);
}

export function getInspectorPort(sessionId: string): number | null {
  return portRegistry.get(sessionId) ?? null;
}

/** Callbacks for externally triggering inspector disconnect/reconnect (e.g., context menu). */
interface InspectorCallbacks {
  disconnect: () => void;
  reconnect: () => void;
}

const callbackRegistry = new Map<string, InspectorCallbacks>();

export function registerInspectorCallbacks(sessionId: string, callbacks: InspectorCallbacks): void {
  callbackRegistry.set(sessionId, callbacks);
}

export function unregisterInspectorCallbacks(sessionId: string): void {
  callbackRegistry.delete(sessionId);
}

export function disconnectInspectorForSession(sessionId: string): void {
  callbackRegistry.get(sessionId)?.disconnect();
}

export function reconnectInspectorForSession(sessionId: string): void {
  callbackRegistry.get(sessionId)?.reconnect();
}
