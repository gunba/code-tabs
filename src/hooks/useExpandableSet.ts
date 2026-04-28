import { useCallback, useMemo, useState } from "react";

export function useExpandableSet(keys: readonly string[]) {
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() => new Set());

  const allExpanded = useMemo(
    () => keys.length > 0 && keys.every((key) => expandedSet.has(key)),
    [expandedSet, keys],
  );

  const toggle = useCallback((key: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setExpandedSet((prev) => {
      if (keys.length === 0) return prev;
      const next = new Set(prev);
      const shouldCollapse = keys.every((key) => prev.has(key));
      if (shouldCollapse) {
        for (const key of keys) next.delete(key);
      } else {
        for (const key of keys) next.add(key);
      }
      return next;
    });
  }, [keys]);

  return { expandedSet, allExpanded, toggle, toggleAll };
}
