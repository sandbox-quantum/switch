import type { ReactNode } from 'react';
import { ConnectionIcon } from '@renderer/features/switch-servers/connection-icon';
import { cn } from '@renderer/utils/utils';

/**
 * One connector as a tile: its icon, its name and the lines under it, with
 * its one control at the top right. Every list of connectors draws its tiles
 * with this, so Discover and the Admin page read as the same thing.
 *
 * A tile that opens something is a button over its whole area, the control
 * keeping its own target above it. One that opens nothing is plain content,
 * so it never invites a click it would ignore. The lines are phrasing
 * content (spans), since they may sit inside that button.
 */
export function ConnectorTile({
  slug,
  name,
  inert,
  onOpen,
  control,
  children,
}: {
  slug: string;
  name: string;
  /** Shown faded and opening nothing: a service not built yet. */
  inert: boolean;
  /** What the whole tile opens; null for a tile whose control is all it offers. */
  onOpen: (() => void) | null;
  control: ReactNode;
  children: ReactNode;
}) {
  const lines = (
    <>
      <span className="block truncate text-sm font-medium text-foreground">{name}</span>
      {children}
    </>
  );
  return (
    <div
      className={cn(
        'relative flex items-start gap-3 rounded-lg border border-border p-4 transition-colors',
        inert ? 'opacity-60' : onOpen && 'hover:bg-background-tertiary-2'
      )}
    >
      <ConnectionIcon slug={slug} name={name} size="lg" />
      {onOpen ? (
        <button
          type="button"
          disabled={inert}
          onClick={onOpen}
          className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none enabled:cursor-pointer disabled:cursor-not-allowed"
        >
          {/* Stretched over the tile, so the whole tile opens it while the
              control beside it keeps its own target. */}
          <span aria-hidden className="absolute inset-0 rounded-lg" />
          {lines}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{lines}</div>
      )}
      {control && <div className="relative z-10 flex shrink-0 items-center gap-2">{control}</div>}
    </div>
  );
}
