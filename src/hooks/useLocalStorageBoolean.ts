import { useCallback, useState } from "react";

export function useLocalStorageBoolean(key: string, defaultValue = false) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultValue : stored === "true";
    } catch {
      return defaultValue;
    }
  });

  const setStoredValue = useCallback((nextValue: boolean | ((prev: boolean) => boolean)) => {
    setValue((prev) => {
      const next = typeof nextValue === "function" ? nextValue(prev) : nextValue;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Storage may be unavailable in tests or constrained WebViews.
      }
      return next;
    });
  }, [key]);

  const toggle = useCallback(() => {
    setStoredValue((prev) => !prev);
  }, [setStoredValue]);

  return [value, toggle, setStoredValue] as const;
}
