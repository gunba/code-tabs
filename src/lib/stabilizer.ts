import { useState, useEffect, useRef } from "react";

/**
 * Stabilizes a rapidly-changing value by requiring it to be identical
 * across consecutive renders before accepting the change.
 *
 * On mount, the first non-null value is accepted immediately.
 * Subsequent changes require `threshold` consecutive identical values.
 */
export function useStabilizedValue(
  value: string | null,
  threshold = 2,
): string | null {
  const [stable, setStable] = useState<string | null>(null);
  const prevRef = useRef<string | null>(null);
  const matchCount = useRef(0);
  const initialized = useRef(false);

  useEffect(() => {
    // Accept first value immediately (avoids delay on tab switch)
    if (!initialized.current) {
      initialized.current = true;
      prevRef.current = value;
      matchCount.current = 1;
      setStable(value);
      return;
    }

    if (value === prevRef.current) {
      matchCount.current++;
      if (matchCount.current >= threshold && value !== stable) {
        setStable(value);
      }
    } else {
      prevRef.current = value;
      matchCount.current = 1;
    }
  }, [value, threshold]);
  // stable intentionally excluded — we compare to current stable to avoid
  // redundant setState, but don't want to re-trigger the effect.

  return stable;
}
