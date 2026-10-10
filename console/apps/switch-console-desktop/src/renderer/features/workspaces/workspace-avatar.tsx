import { cn } from '@renderer/utils/utils';

const SIZE = {
  sm: 'size-5 rounded-md text-[10px]',
  tile: 'size-[22px] rounded-[7px] text-[10.5px]',
  md: 'size-[26px] rounded-md text-xs',
  lg: 'size-9 rounded-lg text-lg',
} as const;

/** A workspace's initial in a square, the way a server's avatar shows a server. */
export function WorkspaceAvatar({
  name,
  size,
  active = false,
}: {
  name: string;
  size: keyof typeof SIZE;
  active?: boolean;
}) {
  // Drawn from an attribute rather than as text, so the letter is not read out
  // or counted as part of the row's name.
  return (
    <span
      aria-hidden
      data-initial={name.trim().charAt(0).toUpperCase() || '?'}
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold before:content-[attr(data-initial)]',
        SIZE[size],
        size === 'tile'
          ? active
            ? 'bg-[var(--accent-solid)] text-[var(--menu-tile-active-fg)]'
            : 'bg-[var(--menu-tile)] text-[var(--menu-tile-fg)]'
          : active
            ? 'bg-[var(--accent-solid)] text-white'
            : 'bg-background-tertiary text-foreground-muted'
      )}
    />
  );
}
