import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_LINUX } from "../lib/paths";

export function useNativeChrome(): boolean {
  const [useNativeChrome, setUseNativeChrome] = useState(false);

  // [PL-01] Linux custom titlebar: tauri.conf.json sets decorations:false globally.
  // Linux normally keeps the custom Header; non-Linux re-enables native decorations
  // at runtime. KDE+Wayland only restores native chrome when GTK is actually using
  // Wayland, where KWin can ignore decorations:false from wry's GTK-Wayland window.
  useEffect(() => {
    (async () => {
      const native = IS_LINUX ? await invoke<boolean>("linux_use_native_chrome").catch(() => false) : true;
      setUseNativeChrome(native);
      if (native) {
        await getCurrentWindow().setDecorations(true).catch(() => {});
      }
    })();
  }, []);

  return useNativeChrome;
}
