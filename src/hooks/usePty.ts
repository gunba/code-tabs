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
  onData: (data: Uint8Array) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
}

export function usePty({ onData, onExit }: UsePtyOptions) {
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
        ...(env ? { env } : {}),
      });

      dlog("pty", null, `spawn success pid=${pty.pid} cwd=${cwd}`);
      ptyRef.current = pty;

      pty.onData(onData);
      pty.onExit((info) => onExit?.(info));

      const handle: PtyHandle = {
        pid: pty.pid,
        write: (data: string) => pty.write(data),
        resize: (cols: number, rows: number) => pty.resize(cols, rows),
        kill: async () => {
          await pty.kill();
          ptyRef.current = null;
        },
      };

      handleRef.current = handle;
      return handle;
    },
    [onData, onExit]
  );

  const cleanup = useCallback(() => {
    handleRef.current?.kill();
    handleRef.current = null;
  }, []);

  return { spawn, cleanup, handle: handleRef };
}
