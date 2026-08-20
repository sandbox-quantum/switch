import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * One save bar for the several editors on an agent page (CHOO-2228).
 *
 * The agent's instructions and its advanced configuration are edited in
 * different places on the page but are one set of pending changes to the
 * person making them, and they write to the same file. So they share a bar:
 * each editor says whether it is dirty and how to save or discard itself, and
 * the bar drives them together.
 *
 * Editors register rather than being listed here, so the bar does not have to
 * know what is on the page — a new editable section joins by calling
 * {@link useAgentEdit}.
 */

/** How to commit or discard one editor's pending changes. */
export type AgentEditHandle = {
  save: () => Promise<void>;
  revert: () => void;
};

type Registration = {
  order: number;
  handle: { current: AgentEditHandle };
};

type AgentEditsValue = {
  register: (id: string, order: number, handle: { current: AgentEditHandle }) => () => void;
  markDirty: (id: string, dirty: boolean) => void;
  dirty: boolean;
  saving: boolean;
  saveAll: () => Promise<void>;
  revertAll: () => void;
};

const AgentEditsContext = createContext<AgentEditsValue | null>(null);

export function AgentEditsProvider({ children }: { children: React.ReactNode }) {
  const registrations = useRef(new Map<string, Registration>());
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);

  const register = useCallback(
    (id: string, order: number, handle: { current: AgentEditHandle }) => {
      registrations.current.set(id, { order, handle });
      return () => {
        registrations.current.delete(id);
        setDirtyIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      };
    },
    []
  );

  const markDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const saveAll = useCallback(async () => {
    // Sequentially, in registration order. The editors read-modify-write the
    // same config file, so saving them at once would have each overwrite what
    // the other just wrote.
    const pending = [...registrations.current.entries()]
      .filter(([id]) => dirtyIds.has(id))
      .sort(([, a], [, b]) => a.order - b.order);

    setSaving(true);
    try {
      for (const [, registration] of pending) {
        await registration.handle.current.save();
      }
    } finally {
      setSaving(false);
    }
  }, [dirtyIds]);

  const revertAll = useCallback(() => {
    for (const registration of registrations.current.values()) {
      registration.handle.current.revert();
    }
  }, []);

  const value = useMemo(
    () => ({ register, markDirty, dirty: dirtyIds.size > 0, saving, saveAll, revertAll }),
    [register, markDirty, dirtyIds, saving, saveAll, revertAll]
  );

  return <AgentEditsContext.Provider value={value}>{children}</AgentEditsContext.Provider>;
}

/** The bar's own view of the page: whether anything is pending, and how to act. */
export function useAgentEdits(): Pick<
  AgentEditsValue,
  'dirty' | 'saving' | 'saveAll' | 'revertAll'
> {
  const context = useContext(AgentEditsContext);
  if (!context) {
    throw new Error('useAgentEdits must be used inside an AgentEditsProvider');
  }
  return context;
}

/**
 * Join this editor to the page's save bar.
 *
 * `order` decides the order saves run in when several are pending — lower
 * first. `handle` is read at save time rather than captured, so a save always
 * commits what is on screen now and not what was there when the editor last
 * re-registered.
 *
 * Outside a provider this is inert, so an editor can also be rendered somewhere
 * with no bar (a modal, say) and keep whatever save affordance it has itself.
 */
export function useAgentEdit(params: {
  id: string;
  order: number;
  dirty: boolean;
  save: () => Promise<void>;
  revert: () => void;
}): void {
  const context = useContext(AgentEditsContext);
  const { id, order, dirty } = params;

  const handle = useRef<AgentEditHandle>({ save: params.save, revert: params.revert });
  handle.current = { save: params.save, revert: params.revert };

  const register = context?.register;
  const markDirty = context?.markDirty;

  useEffect(() => {
    if (!register) return;
    return register(id, order, handle);
  }, [register, id, order]);

  useEffect(() => {
    if (!markDirty) return;
    markDirty(id, dirty);
  }, [markDirty, id, dirty]);
}
