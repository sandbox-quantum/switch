import { ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * A section of a machine's page that folds away under its title, with the
 * caret beside the title as the chat's thinking line has it.
 */
export function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  /** Whether it starts open. */
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <section>
      <h3 className="text-[11.5px] text-[#8A8A8A]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((shown) => !shown)}
          className="focus-visible:ring-ring -mx-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:outline-none"
        >
          {title}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3 shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-90'
            )}
          />
        </button>
      </h3>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
