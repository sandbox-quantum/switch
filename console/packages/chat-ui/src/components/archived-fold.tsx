import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';

/** A fold under a list holding its archived entries, closed until asked for; nothing when there are none. */
export function ArchivedFold({
  count,
  error,
  children,
}: {
  count: number;
  error: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0 && !error) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col gap-[2px] pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-foreground-muted hover:text-foreground"
      >
        <Chevron className="size-3.5" />
        Archived{count > 0 ? ` (${count})` : ''}
      </button>
      {open && error && <p className="px-2 py-1 text-xs text-foreground-muted">{error}</p>}
      {open && children}
    </div>
  );
}
