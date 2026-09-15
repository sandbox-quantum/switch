import { X } from 'lucide-react';
import { cn } from '@renderer/utils/utils';

/**
 * Something already picked, with the way to take it back out: a mark, a name,
 * a line under it, and a remove button on hover. One shape behind every
 * "chosen" grid, so the grids match and a new kind of pick gets it for free.
 */
export function ChosenTile({
  mark,
  title,
  subtitle,
  subtitleTone = 'muted',
  onRemove,
}: {
  mark: React.ReactNode;
  title: string;
  subtitle: string;
  /** `warning` for a subtitle that says something is off with the pick, such
   * as a name the server does not know. */
  subtitleTone?: 'muted' | 'warning';
  onRemove: () => void;
}) {
  return (
    // `--fill` rather than `--surface-2`: in dark mode that surface is the
    // dialog's own background, so a tile drawn in it was a tile nobody could
    // see.
    <div className="group relative flex flex-col gap-2 rounded-[10px] bg-[var(--fill)] p-3">
      {mark}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{title}</span>
        <span
          className={cn(
            'truncate text-xs',
            subtitleTone === 'warning'
              ? 'text-amber-600 dark:text-amber-500'
              : 'text-foreground-muted'
          )}
        >
          {subtitle}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Remove ${title}`}
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--fill-2)] hover:text-foreground focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
