import type { LucideIcon } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { cn } from '@renderer/utils/utils';

/**
 * A small segmented control: every choice visible at once, the active one
 * raised out of a recessed track.
 *
 * The raised option has to read as sitting *in* the track, not as a button
 * dropped on top of a box: concentric corners (inner radius = outer radius less
 * the padding) and only a hairline of track showing around it.
 *
 * Re-selecting the active option is a no-op rather than a deselect — with only
 * these choices on offer, "none of them" is not a state the caller can draw.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  quiet = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string; icon?: LucideIcon }[];
  ariaLabel: string;
  className?: string;
  /**
   * A lighter control for the sidebar: a faint track and a faint fill on the
   * chosen option, no raised button and no shadow, so it sits as quietly as the
   * headings around it.
   */
  quiet?: boolean;
}) {
  return (
    <ToggleGroup
      size="sm"
      spacing={1}
      multiple={false}
      value={[value]}
      onValueChange={([next]) => {
        const option = options.find((o) => o.value === next);
        if (option) onChange(option.value);
      }}
      aria-label={ariaLabel}
      className={cn(
        'h-auto gap-0 rounded-[9px] border-transparent bg-[var(--segment-track)] p-[2px]',
        quiet && 'rounded-[8px] bg-[var(--hair-soft)]',
        className
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.label}
          // The hover fill is an overlay, and only on the option that is not
          // already chosen: the default `background-1` is the dialog and panel
          // surface itself in dark mode, so it draws nothing.
          className={cn(
            'h-auto cursor-pointer rounded-[7px] px-[9px] py-[2px] text-[11.5px] font-medium text-foreground-muted transition-colors hover:bg-transparent hover:text-foreground aria-pressed:bg-[var(--btn-1)] aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_rgb(0_0_0_/_0.12)] aria-[pressed=false]:hover:bg-[var(--sel-soft)] data-pressed:bg-[var(--btn-1)] data-[state=on]:bg-[var(--btn-1)] data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0_/_0.12)]',
            quiet &&
              'rounded-[6px] px-2.5 text-[var(--fg-dim)] aria-pressed:bg-[var(--menu-pill)] aria-pressed:text-[var(--fg-name)] aria-pressed:shadow-none data-pressed:bg-[var(--menu-pill)] data-[state=on]:bg-[var(--menu-pill)] data-[state=on]:shadow-none'
          )}
        >
          {option.icon && <option.icon className="size-3.5" />}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
