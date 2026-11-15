import { cn } from '@renderer/utils/utils';

/** One titled card of a device's page. */
export function Card({
  title,
  subtitle,
  children,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-[10px] border border-border bg-background p-4', className)}>
      <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
      {subtitle && <p className="text-[12px] text-[var(--fg-dim)]">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
