import { ChevronRight } from 'lucide-react';
import { cn } from '@renderer/utils/utils';

/**
 * The class a collapsed section's header row wears. Exported for the one header
 * that cannot use `DisclosureRow` — the sidecar log's open state carries a
 * Refresh button beside its title, so it is a row containing two controls
 * rather than one control shaped like a row.
 */
export const disclosureRowClass =
  '-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-foreground-muted transition-colors hover:bg-[var(--sel-soft)]';

/**
 * The header of a collapsible section: a chevron, what it is, and what it is
 * holding while shut.
 *
 * The whole row highlights on hover rather than the chevron alone. A pointer
 * change is the only feedback a bare row gives, and it arrives after you have
 * already guessed the thing is clickable.
 */
export function DisclosureRow({
  open,
  title,
  summary,
  meta,
  className,
  onToggle,
}: {
  open: boolean;
  title: string;
  /** What the section holds, beside the title. */
  summary?: React.ReactNode;
  /** How much it holds, pushed to the right edge. */
  meta?: React.ReactNode;
  className?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(disclosureRowClass, className)}
    >
      <ChevronRight className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
      <span className="shrink-0 font-medium text-foreground">{title}</span>
      {summary !== undefined && <span className="min-w-0 truncate">{summary}</span>}
      {meta !== undefined && <span className="ml-auto shrink-0 pl-2">{meta}</span>}
    </button>
  );
}
