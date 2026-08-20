import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * One step of a titlebar trail. `onClick` makes the step navigable; the last
 * step is where you already are, so it never takes one.
 */
export type TitlebarCrumb = {
  key: string;
  icon?: ReactNode;
  label: string;
  onClick?: () => void;
  /** How much of the label to show before truncating. Defaults to a shared cap. */
  maxWidthClassName?: string;
};

/**
 * The trail in the titlebar saying where you are — server, agent, room,
 * session, in whatever depth the page actually knows.
 *
 * One component rather than one per page: the trail was hand-rolled four times
 * over, in four shapes, and the pages had begun to disagree about the same
 * objects — a room was "server / room" in one place and unlabelled in another.
 */
export function TitlebarBreadcrumb({ crumbs }: { crumbs: readonly TitlebarCrumb[] }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        const content = (
          <>
            {crumb.icon}
            <span className={cn('truncate', crumb.maxWidthClassName ?? 'max-w-56')}>
              {crumb.label}
            </span>
          </>
        );

        return (
          <Fragment key={crumb.key}>
            {index > 0 && <span className="text-foreground-passive">/</span>}
            {crumb.onClick && !isLast ? (
              <button
                type="button"
                onClick={crumb.onClick}
                className="flex min-w-0 items-center gap-1.5 text-foreground-muted hover:text-foreground"
              >
                {content}
              </button>
            ) : (
              <span
                className={cn(
                  'flex min-w-0 items-center gap-1.5',
                  isLast ? 'text-foreground' : 'text-foreground-muted'
                )}
              >
                {content}
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
