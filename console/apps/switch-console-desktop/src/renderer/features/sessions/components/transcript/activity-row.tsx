import type { ItemType } from '@switch-console/agent-providers';
import {
  Bot,
  Brain,
  ChevronRight,
  FilePen,
  Globe,
  Layers,
  Loader2,
  MessageSquare,
  Terminal,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { ActivityEntry } from '@renderer/features/sessions/stores/session-transcript-store';
import { cn } from '@renderer/utils/utils';
import type { TranscriptItem } from '@shared/core/sessions/session-transcript';

const ITEM_ICONS: Record<ItemType, LucideIcon> = {
  user_message: MessageSquare,
  assistant_message: MessageSquare,
  reasoning: Brain,
  command_execution: Terminal,
  file_change: FilePen,
  mcp_tool_call: Wrench,
  tool_call: Wrench,
  web_search: Globe,
  subagent: Bot,
  context_compaction: Layers,
};

/** What the row says before its title: a category, or the agent behind a subagent. */
function itemLabel(item: TranscriptItem): string | null {
  if (item.type === 'subagent') return `Subagent · ${item.toolName ?? item.title}`;
  if (item.type === 'reasoning') return 'Thinking…';
  if (item.type === 'mcp_tool_call' || item.type === 'tool_call') return item.toolName ?? null;
  return null;
}

/** The row's own text, when the label has not already said it. */
function itemTitle(item: TranscriptItem): string {
  if (item.type === 'subagent') return item.status === 'in_progress' ? 'running' : 'finished';
  if (item.type === 'reasoning') return '';
  return item.title;
}

function StatusMark({ status }: { status: TranscriptItem['status'] }) {
  if (status === 'in_progress') {
    return <Loader2 className="size-3 shrink-0 animate-spin text-foreground-passive" />;
  }
  if (status === 'failed') {
    return <TriangleAlert className="size-3 shrink-0 text-foreground-destructive" />;
  }
  if (status === 'declined') {
    return <span className="shrink-0 text-tiny text-foreground-passive">declined</span>;
  }
  return null;
}

/** One line of agent activity. Click to open the item's output, when it has any. */
export function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const item = entry.item;
  const Icon = ITEM_ICONS[item.type] ?? Wrench;
  const label = itemLabel(item);
  const title = itemTitle(item);
  const expandable = Boolean(item.text && item.text.trim().length > 0);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((value) => !value)}
        className={cn(
          'group flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors',
          expandable ? 'hover:bg-background-1' : 'cursor-default'
        )}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-foreground-passive transition-transform',
            !expandable && 'invisible',
            open && 'rotate-90'
          )}
        />
        <Icon
          className={cn(
            'size-3 shrink-0',
            item.status === 'failed' ? 'text-foreground-destructive' : 'text-foreground-passive'
          )}
        />
        {label && (
          <span className="shrink-0 text-tiny font-medium text-foreground-muted">{label}</span>
        )}
        {title && (
          <span className="min-w-0 flex-1 truncate font-mono text-tiny text-foreground-passive">
            {title}
          </span>
        )}
        <StatusMark status={item.status} />
      </button>
      {open && item.text && (
        <pre className="mt-1 mb-1 ml-6 max-h-72 overflow-auto rounded-md border border-border bg-background-1 px-2.5 py-2 font-mono text-tiny whitespace-pre-wrap text-foreground-muted">
          {item.text}
        </pre>
      )}
    </div>
  );
}

/**
 * A run of consecutive activity rows.
 *
 * More than one collapses to a single summary line so a turn that ran a dozen
 * tools does not push the message that caused them off the screen. A run of one
 * is just that row — a "1 action" fold hides nothing worth folding.
 */
export function ActivityGroup({ items }: { items: ActivityEntry[] }) {
  const [open, setOpen] = useState(false);
  const running = items.some((entry) => entry.item.status === 'in_progress');

  if (items.length === 1 || open) {
    return (
      <section
        aria-label="Activity"
        className="flex flex-col gap-px border-l border-border pl-2 text-foreground-muted"
      >
        {items.length > 1 && (
          <button
            type="button"
            aria-expanded
            onClick={() => setOpen(false)}
            className="flex items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-tiny text-foreground-passive transition-colors hover:bg-background-1"
          >
            <ChevronRight className="size-3 rotate-90" />
            {items.length} actions
          </button>
        )}
        {items.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </section>
    );
  }

  return (
    <section aria-label="Activity" className="border-l border-border pl-2">
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-tiny text-foreground-passive transition-colors hover:bg-background-1"
      >
        <ChevronRight className="size-3" />
        {running ? <Loader2 className="size-3 animate-spin" /> : <Wrench className="size-3" />}
        {items.length} actions
      </button>
    </section>
  );
}
