import { detectPlatform } from '@tanstack/react-hotkeys';
import { type ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';

const isLinux = detectPlatform() === 'linux';

export function Titlebar({
  leftSlot,
  rightSlot,
  className,
  leftClassName,
  rightClassName,
}: {
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  className?: string;
  leftClassName?: string;
  rightClassName?: string;
}) {
  return (
    <header
      className={cn(
        // No fill and no bottom rule: the header is part of the panel's own
        // surface, so a bar across the top of it would read as a second
        // divider next to the gutter that already separates panel from
        // sidebar.
        'flex h-11 shrink-0 items-center [-webkit-app-region:drag]',
        // No traffic-light padding and no sidebar controls here: the window's
        // top bar sits above the panel and holds both when the sidebar is
        // collapsed (see `WorkspaceTopBar`).
        // Linux draws its own controls flush to the right corner (no native
        // frame); everywhere else keep the normal right padding.
        isLinux ? 'pr-0' : 'pr-[18px]',
        className
      )}
    >
      <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1 self-stretch">
        <div className="flex w-full items-center justify-between self-stretch">
          <div
            className={cn(
              'flex items-center justify-start [-webkit-app-region:no-drag]',
              leftClassName
            )}
          >
            {leftSlot}
          </div>
          <div
            className={cn(
              'flex items-center justify-end [-webkit-app-region:no-drag]',
              rightClassName
            )}
          >
            {rightSlot}
          </div>
        </div>
      </div>
    </header>
  );
}
