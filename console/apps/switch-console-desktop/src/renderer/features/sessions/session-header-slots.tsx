import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Lets the transcript put its session state and its actions in the titlebar.
 *
 * The header is one row shared by two components the view registry renders as
 * siblings: the titlebar owns the breadcrumb, the pin and the overflow menu,
 * while the state pill and the Restart/Stop buttons are driven by the
 * transcript's live view of the session. Rather than lift that state up, the
 * transcript renders through to mount points the titlebar puts down.
 *
 * A portal rather than a stored node: the contents change on every turn, and a
 * node held in state would have to be re-published on each of them.
 */
type Slots = {
  left: HTMLElement | null;
  right: HTMLElement | null;
  mount: (slot: 'left' | 'right', element: HTMLElement | null) => void;
};

const SessionHeaderSlotsContext = createContext<Slots | null>(null);

export function SessionHeaderSlotsProvider({ children }: { children: ReactNode }) {
  const [left, setLeft] = useState<HTMLElement | null>(null);
  const [right, setRight] = useState<HTMLElement | null>(null);
  const value = useMemo<Slots>(
    () => ({
      left,
      right,
      mount: (slot, element) => (slot === 'left' ? setLeft(element) : setRight(element)),
    }),
    [left, right]
  );
  return (
    <SessionHeaderSlotsContext.Provider value={value}>
      {children}
    </SessionHeaderSlotsContext.Provider>
  );
}

/** The titlebar's mount point for one side of the header. */
export function SessionHeaderOutlet({
  slot,
  className,
}: {
  slot: 'left' | 'right';
  className: string;
}) {
  const slots = useContext(SessionHeaderSlotsContext);
  return <div ref={(element) => slots?.mount(slot, element)} className={className} />;
}

/**
 * Renders into the titlebar from inside the transcript. Nothing while the
 * titlebar is absent, which is how a session shown without one stays silent
 * rather than drawing a second header of its own.
 */
export function SessionHeaderContent({
  slot,
  children,
}: {
  slot: 'left' | 'right';
  children: ReactNode;
}) {
  const slots = useContext(SessionHeaderSlotsContext);
  const element = slots?.[slot] ?? null;
  return element ? createPortal(children, element) : null;
}
