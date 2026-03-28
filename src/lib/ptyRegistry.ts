/**
 * Global PTY writer registry.
 *
 * TerminalPanel registers its PTY write function on mount and
 * unregisters on unmount. This enables routing text input to the
 * correct session's terminal by session ID.
 *
 * All PTY input flows through writeToPty() — a LineAccumulator per
 * session reconstructs submitted lines and detects slash commands
 * synchronously at the point of write.
 */

import { LineAccumulator } from "./inputAccumulator";
import { useSessionStore } from "../store/sessions";

const ptyWriters = new Map<string, (data: string) => void>();
const ptyKills = new Map<string, () => Promise<void>>();
const accumulators = new Map<string, LineAccumulator>();

/** Register a PTY write function for a session. */
export function registerPtyWriter(sessionId: string, write: (data: string) => void): void {
  ptyWriters.set(sessionId, write);
  accumulators.set(sessionId, new LineAccumulator());
}

/** Unregister a PTY write function when a session is cleaned up. */
export function unregisterPtyWriter(sessionId: string): void {
  ptyWriters.delete(sessionId);
  accumulators.delete(sessionId);
}

/** Write data to a session's PTY. Returns true if the writer was found. */
export function writeToPty(sessionId: string, data: string): boolean {
  const write = ptyWriters.get(sessionId);
  if (!write) return false;

  // Feed through line accumulator to detect submitted commands
  const acc = accumulators.get(sessionId);
  if (acc) {
    const lines = acc.feed(data);
    for (const line of lines) {
      if (line.charAt(0) === "/") {
        const cmd = line.split(/\s/)[0];
        useSessionStore.getState().addCommandHistory(sessionId, cmd);
      }
    }
  }

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
