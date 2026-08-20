import { cn } from '@renderer/utils/utils';

/**
 * The quiet heading over a run of settings on the agent page — General, Sidecar,
 * Sessions. Smaller and greyer than anything under it: it groups rows rather
 * than competing with them for the eye.
 */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn('text-[13px] font-medium text-foreground-muted', className)}>{children}</h2>
  );
}
