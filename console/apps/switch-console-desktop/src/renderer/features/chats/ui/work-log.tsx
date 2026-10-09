import {
  Bot,
  Brain,
  ChevronRightIcon,
  CircleAlert,
  FileText,
  Globe,
  Hammer,
  ListTodo,
  MessagesSquare,
  Plug,
  Search,
  SquarePen,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';
import type { ToolKind } from '../tool-presentation';

/**
 * A turn's work as a quiet log: one compact line per step, an icon for what
 * kind of step it was and a muted label, with no cards or status badges. A
 * line that has more to show opens in place; one that has nothing does not
 * pretend to. The layout follows the work log in T3 Code (MIT, T3 Tools Inc.),
 * re-implemented on this app's tokens.
 */

const ICONS: Record<ToolKind, typeof Terminal> = {
  shell: Terminal,
  read: FileText,
  edit: SquarePen,
  search: Search,
  web: Globe,
  agent: Bot,
  todo: ListTodo,
  switch: MessagesSquare,
  mcp: Plug,
  other: Wrench,
};

export function ToolKindIcon({ kind }: { kind: ToolKind | null }) {
  const Icon = kind ? ICONS[kind] : Hammer;
  return <Icon aria-hidden className="size-3.5" />;
}

export const ThinkingIcon = () => <Brain aria-hidden className="size-3.5" />;
export const FailedIcon = () => <CircleAlert aria-hidden className="size-3.5" />;

export function WorkLogRow({
  icon,
  label,
  trailing,
  tone = 'default',
  active = false,
  open,
  onToggle,
  title,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  /** `failed` tints the icon red; `passive` mutes the label further. */
  tone?: 'default' | 'failed' | 'passive';
  /** Work still under way: the label shimmers. */
  active?: boolean;
  /** Present with `onToggle` only: whether the details are showing. */
  open?: boolean;
  onToggle?: () => void;
  title?: string;
  children?: ReactNode;
}) {
  const line = (
    <>
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center',
          tone === 'failed' ? 'text-foreground-destructive' : 'text-foreground-passive'
        )}
      >
        {icon}
      </span>
      <span
        className={cn('min-w-0 flex-1 truncate', tone === 'passive' && 'text-foreground-passive')}
      >
        {active ? <span className="text-shimmer">{label}</span> : label}
      </span>
      {trailing}
      {onToggle && (
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-foreground-passive opacity-0 transition-[transform,opacity] group-hover/work-row:opacity-100 group-focus-visible/work-row:opacity-100 motion-reduce:transition-none',
            open && 'rotate-90 opacity-100'
          )}
        />
      )}
    </>
  );
  const lineClass =
    'flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 text-left text-sm leading-relaxed text-foreground-muted';
  return (
    <div data-slot="work-log-row" className="min-w-0">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          title={title}
          className={cn(
            lineClass,
            'group/work-row cursor-pointer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset'
          )}
        >
          {line}
        </button>
      ) : (
        <div className={lineClass} title={title}>
          {line}
        </div>
      )}
      {children}
    </div>
  );
}

/** What an opened line shows, indented under its label. */
export function WorkLogDetails({ children }: { children: ReactNode }) {
  return <div className="ms-6 mt-0.5 mb-1.5 flex min-w-0 flex-col gap-1.5">{children}</div>;
}

export function WorkLogPre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto rounded-md border border-border bg-background-1 px-2.5 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground-muted select-text',
        className
      )}
    >
      {children}
    </pre>
  );
}

export function WorkLogNote({
  children,
  tone = 'passive',
}: {
  children: ReactNode;
  tone?: 'passive' | 'failed';
}) {
  return (
    <p
      className={cn(
        'text-xs',
        tone === 'failed' ? 'text-foreground-destructive' : 'text-foreground-passive'
      )}
    >
      {children}
    </p>
  );
}
