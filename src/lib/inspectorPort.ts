/**
 * Sequential port allocator for BUN_INSPECT WebSocket connections.
 * Each session gets a unique port. Ports are never reused within app lifetime.
 * Range: 6400-6499 (100 ports, well above typical concurrent session count).
 * Wraps around to 6400 if exhausted (old sessions will have closed by then).
 */
const PORT_MIN = 6400;
const PORT_MAX = 6499;
let nextPort = PORT_MIN;

export function allocateInspectorPort(): number {
  const port = nextPort++;
  if (nextPort > PORT_MAX) nextPort = PORT_MIN;
  return port;
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
