import { useCallback, useRef } from "react";
import { spawnPty, type PtyProcess } from "../lib/ptyProcess";
import { dlog } from "../lib/debugLog";

export interface PtyHandle {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => Promise<void>;
}

interface UsePtyOptions {
  sessionId?: string | null;
  onData: (data: Uint8Array) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
}

export function usePty({ sessionId = null, onData, onExit }: UsePtyOptions) {
  const ptyRef = useRef<PtyProcess | null>(null);
  const handleRef = useRef<PtyHandle | null>(null);

  const spawn = useCallback(
    async (
      file: string,
      args: string[],
      cwd: string,
      cols: number,
      rows: number,
      env?: Record<string, string>
    ): Promise<PtyHandle> => {
      const pty = await spawnPty(file, args, {
        cwd,
        cols,
        rows,
        sessionId,
        ...(env ? { env } : {}),
      });

      dlog("pty", sessionId, `spawn success pid=${pty.pid} cwd=${cwd}`, "LOG", {
        event: "pty.spawn_success",
        data: { pid: pty.pid, cwd, cols, rows },
      });
      ptyRef.current = pty;

      pty.onData(onData);
      pty.onExit((info) => {
        dlog("pty", sessionId, "PTY onExit callback invoked", "DEBUG", {
          event: "pty.exit_callback",
          data: { pid: pty.pid, info },
        });
        onExit?.(info);
      });

      const handle: PtyHandle = {
        pid: pty.pid,
        write: (data: string) => pty.write(data),
        resize: (cols: number, rows: number) => pty.resize(cols, rows),
        kill: async () => {
          dlog("pty", sessionId, "PTY handle kill invoked", "LOG", {
            event: "pty.handle_kill",
            data: { pid: pty.pid },
          });
          await pty.kill();
          ptyRef.current = null;
        },
      };

      handleRef.current = handle;
      return handle;
    },
    [onData, onExit, sessionId]
  );

  const cleanup = useCallback(() => {
    dlog("pty", sessionId, "PTY cleanup requested", "DEBUG", {
      event: "pty.cleanup",
      data: { hasHandle: !!handleRef.current },
    });
    handleRef.current?.kill();
    handleRef.current = null;
  }, [sessionId]);

  return { spawn, cleanup, handle: handleRef };
}
