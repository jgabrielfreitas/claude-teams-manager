import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * What the user currently has "selected", so the shared command catalogue can
 * decide which commands are available (`requires: 'team' | 'agent' | 'run'`).
 * Pages declare it; the palette reads it.
 */
export interface Selection {
  teamId?: string;
  agentId?: string;
  runId?: string;
}

interface SelectionValue extends Selection {
  set: (selection: Selection) => void;
}

const SelectionContext = createContext<SelectionValue | undefined>(undefined);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Selection>({});
  const value = useMemo<SelectionValue>(
    () => ({ ...selection, set: setSelection }),
    [selection],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error('useSelection must be used inside <SelectionProvider>');
  return value;
}

/** Declares what this page has selected for as long as it is mounted. */
export function useDeclareSelection(selection: Selection): void {
  const { set } = useSelection();
  const { teamId, agentId, runId } = selection;
  useEffect(() => {
    set({ teamId, agentId, runId });
    return () => set({});
  }, [set, teamId, agentId, runId]);
}
