/**
 * Global PTY writer registry.
 *
 * TerminalPanel registers its PTY write function on mount and
 * unregisters on unmount. This enables routing text input to the
 * correct session's terminal by session ID.
 */

import { dlog } from "./debugLog";

const ptyWriters = new Map<string, (data: string) => void>();
const ptyKills = new Map<string, () => Promise<void>>();
const ptyHandleIds = new Map<string, number>();

function escapeDataPreview(data: string): string {
  return data
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .slice(0, 240);
}

/** Register a PTY write function for a session. */
export function registerPtyWriter(sessionId: string, write: (data: string) => void): void {
  ptyWriters.set(sessionId, write);
  dlog("pty", sessionId, "registered PTY writer", "DEBUG", {
    event: "pty.writer_registered",
    data: { sessionId },
  });
}

/** Unregister a PTY write function when a session is cleaned up. */
export function unregisterPtyWriter(sessionId: string): void {
  ptyWriters.delete(sessionId);
  dlog("pty", sessionId, "unregistered PTY writer", "DEBUG", {
    event: "pty.writer_unregistered",
    data: { sessionId },
  });
}

/** [DF-01] Write data to a session's PTY. Returns true if the writer was found. */
export function writeToPty(sessionId: string, data: string): boolean {
  const write = ptyWriters.get(sessionId);
  if (!write) {
    dlog("pty", sessionId, "PTY write requested without registered writer", "WARN", {
      event: "pty.write_missing",
      data: {
        sessionId,
        length: data.length,
        text: data,
        preview: escapeDataPreview(data),
      },
    });
    return false;
  }
  dlog("pty", sessionId, "forwarding input to PTY", "DEBUG", {
    event: "pty.write_request",
    data: {
      sessionId,
      length: data.length,
      text: data,
      preview: escapeDataPreview(data),
    },
  });
  write(data);
  return true;
}

/** Register a PTY kill function for a session. */
export function registerPtyKill(sessionId: string, kill: () => Promise<void>): void {
  ptyKills.set(sessionId, kill);
  dlog("pty", sessionId, "registered PTY kill handler", "DEBUG", {
    event: "pty.kill_registered",
    data: { sessionId },
  });
}

/** Unregister a PTY kill function when a session is cleaned up. */
export function unregisterPtyKill(sessionId: string): void {
  ptyKills.delete(sessionId);
  dlog("pty", sessionId, "unregistered PTY kill handler", "DEBUG", {
    event: "pty.kill_unregistered",
    data: { sessionId },
  });
}

/** Kill a session's PTY and wait for process exit. No-op if no PTY registered. */
export async function killPty(sessionId: string): Promise<void> {
  const kill = ptyKills.get(sessionId);
  if (!kill) {
    dlog("pty", sessionId, "kill requested without registered PTY handle", "WARN", {
      event: "pty.kill_missing",
      data: { sessionId },
    });
    return;
  }
  dlog("pty", sessionId, "kill requested via registry", "LOG", {
    event: "pty.kill_request",
    data: { sessionId },
  });
  await kill();
}

/** Register the PTY handle ID for a session (for recording commands). */
export function registerPtyHandleId(sessionId: string, pid: number): void {
  ptyHandleIds.set(sessionId, pid);
  dlog("pty", sessionId, "registered PTY handle id", "DEBUG", {
    event: "pty.handle_registered",
    data: { sessionId, pid },
  });
}

/** Unregister the PTY handle ID when a session is cleaned up. */
export function unregisterPtyHandleId(sessionId: string): void {
  ptyHandleIds.delete(sessionId);
  dlog("pty", sessionId, "unregistered PTY handle id", "DEBUG", {
    event: "pty.handle_unregistered",
    data: { sessionId },
  });
}

/** Get the PTY handle ID for a session, or null if not registered. */
export function getPtyHandleId(sessionId: string): number | null {
  return ptyHandleIds.get(sessionId) ?? null;
}
