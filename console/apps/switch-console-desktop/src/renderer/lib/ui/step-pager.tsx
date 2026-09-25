import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@renderer/utils/utils';
import { Button } from './button';

/**
 * The bar at the foot of a paged flow: which page you are on, and the way back
 * or on from it.
 *
 * It names the page rather than counting it. A count is only honest once the
 * sequence has a fixed length, and these flows branch — how many pages are left
 * after "Add a server" depends on the answer given there — so a number would
 * have to renumber itself halfway through.
 *
 * An arrow only repeats a move the page already offers — its Back, its Next.
 * Where the way on is a button that installs a stack, signs you in or creates a
 * server, the page passes a null `onNext`: a chevron whose whole label is "next"
 * must not be the thing that commits you to any of those. The inert arrow stays
 * on screen rather than disappearing, so the bar keeps its shape from page to
 * page and the name does not shift under the eye.
 *
 * An inert arrow is `aria-disabled` rather than `disabled`, and says in its
 * label why it leads nowhere. A chevron is already a control that explains
 * nothing on sight; dropping it out of the tab order as well would leave the
 * one place the reason is written unreachable by the people who most need it.
 */
export function StepPager({
  pageName,
  onBack,
  onNext,
}: {
  pageName: string;
  onBack: (() => void) | null;
  onNext: (() => void) | null;
}) {
  return (
    <nav
      aria-label="Pages in this flow"
      className="flex shrink-0 items-center justify-center gap-4 border-t border-border bg-background-quaternary-1 px-3 py-1.5"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={onBack === null ? 'Previous page — this is the first page' : 'Previous page'}
        aria-disabled={onBack === null || undefined}
        className={cn(onBack === null && 'opacity-50')}
        onClick={onBack ?? undefined}
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <span aria-current="step" className="min-w-40 text-center text-xs text-foreground-muted">
        {pageName}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={
          onNext === null ? 'Next page — use the button on this page to go on' : 'Next page'
        }
        aria-disabled={onNext === null || undefined}
        className={cn(onNext === null && 'opacity-50')}
        onClick={onNext ?? undefined}
      >
        <ChevronRight className="size-3.5" />
      </Button>
    </nav>
  );
}
