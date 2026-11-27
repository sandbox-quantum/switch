import { cn } from '../model/cn';

export type Tone = 'ok' | 'warning' | 'problem' | 'idle';

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-green-500',
  warning: 'bg-amber-500',
  problem: 'bg-red-500',
  idle: 'bg-foreground-muted',
};

const PILL: Record<Tone, string> = {
  ok: 'bg-background-success text-foreground-success',
  warning: 'bg-background-warning text-foreground-warning',
  problem: 'bg-background-error text-foreground-error',
  idle: 'bg-background-tertiary text-foreground-muted',
};

export function TonePill({
  tone,
  label,
  title,
  dot = true,
}: {
  tone: Tone;
  label: string;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] whitespace-nowrap',
        PILL[tone]
      )}
    >
      {dot && <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />}
      {label}
    </span>
  );
}
