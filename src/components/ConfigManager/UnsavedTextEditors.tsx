import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

export interface UnsavedTextEditorChange {
  id: string;
  title: string;
  before: string;
  after: string;
}

type UnsavedTextEditorSnapshot = Omit<UnsavedTextEditorChange, "id"> | null;

export interface UnsavedTextEditorRegistry {
  register: (id: string, getChange: () => UnsavedTextEditorSnapshot) => () => void;
  getChanges: () => UnsavedTextEditorChange[];
}

const UnsavedTextEditorContext = createContext<UnsavedTextEditorRegistry | null>(null);

export function useUnsavedTextEditorRegistry(): UnsavedTextEditorRegistry {
  const entriesRef = useRef(new Map<string, () => UnsavedTextEditorSnapshot>());

  const register = useCallback((id: string, getChange: () => UnsavedTextEditorSnapshot) => {
    entriesRef.current.set(id, getChange);
    return () => {
      if (entriesRef.current.get(id) === getChange) {
        entriesRef.current.delete(id);
      }
    };
  }, []);

  const getChanges = useCallback(() => {
    const changes: UnsavedTextEditorChange[] = [];
    for (const [id, getChange] of entriesRef.current) {
      const change = getChange();
      if (change && change.before !== change.after) {
        changes.push({ id, ...change });
      }
    }
    return changes;
  }, []);

  return useMemo(() => ({ register, getChanges }), [register, getChanges]);
}

export function UnsavedTextEditorProvider({
  registry,
  children,
}: {
  registry: UnsavedTextEditorRegistry;
  children: ReactNode;
}) {
  return (
    <UnsavedTextEditorContext.Provider value={registry}>
      {children}
    </UnsavedTextEditorContext.Provider>
  );
}

export function useUnsavedTextEditor(id: string, getChange: () => UnsavedTextEditorSnapshot) {
  const registry = useContext(UnsavedTextEditorContext);
  const getChangeRef = useRef(getChange);

  useEffect(() => {
    getChangeRef.current = getChange;
  }, [getChange]);

  useEffect(() => {
    if (!registry) return;
    return registry.register(id, () => getChangeRef.current());
  }, [registry, id]);
}
