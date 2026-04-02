/**
 * Global PTY writer registry.
 *
 * TerminalPanel registers its PTY write function on mount and
 * unregisters on unmount. This enables routing text input to the
 * correct session's terminal by session ID.
 */

const ptyWriters = new Map<string, (data: string) => void>();
const ptyKills = new Map<string, () => Promise<void>>();
const ptyHandleIds = new Map<string, number>();

/** Register a PTY write function for a session. */
export function registerPtyWriter(sessionId: string, write: (data: string) => void): void {
  ptyWriters.set(sessionId, write);
}

/** Unregister a PTY write function when a session is cleaned up. */
export function unregisterPtyWriter(sessionId: string): void {
  ptyWriters.delete(sessionId);
}

/** [DF-01] Write data to a session's PTY. Returns true if the writer was found. */
export function writeToPty(sessionId: string, data: string): boolean {
  const write = ptyWriters.get(sessionId);
  if (!write) return false;
  write(data);
  return true;
}

/** Register a PTY kill function for a session. */
export function registerPtyKill(sessionId: string, kill: () => Promise<void>): void {
  ptyKills.set(sessionId, kill);
}

/** Unregister a PTY kill function when a session is cleaned up. */
export function unregisterPtyKill(sessionId: string): void {
  ptyKills.delete(sessionId);
}

/** Kill a session's PTY and wait for process exit. No-op if no PTY registered. */
export async function killPty(sessionId: string): Promise<void> {
  const kill = ptyKills.get(sessionId);
  if (kill) await kill();
}

/** Register the PTY handle ID for a session (for recording commands). */
export function registerPtyHandleId(sessionId: string, pid: number): void {
  ptyHandleIds.set(sessionId, pid);
}

/** Unregister the PTY handle ID when a session is cleaned up. */
export function unregisterPtyHandleId(sessionId: string): void {
  ptyHandleIds.delete(sessionId);
}

/** Get the PTY handle ID for a session, or null if not registered. */
export function getPtyHandleId(sessionId: string): number | null {
  return ptyHandleIds.get(sessionId) ?? null;
}
