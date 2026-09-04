import { Info, TriangleAlert, XCircle } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { cn } from '@renderer/utils/utils';
import type { TranscriptEntry } from '@shared/core/sessions/session-transcript';

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>;
type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>;
type NoticeEntry = Extract<TranscriptEntry, { kind: 'notice' }>;

const SOURCE_TAGS = { room: 'from room', system: 'system' } as const;

/**
 * A message from a person — or, when it came over a room, from whoever
 * addressed the agent there. Set apart from the agent's own replies by
 * alignment and a surface rather than a name, which would be a name per
 * message for a conversation that only ever has two sides.
 */
export const UserMessage = observer(function UserMessage({ entry }: { entry: UserEntry }) {
  const tag = entry.source === 'console' ? null : SOURCE_TAGS[entry.source];
  return (
    <div className="flex flex-col items-end gap-1">
      {tag && (
        <span className="text-tiny tracking-wide text-foreground-passive uppercase">{tag}</span>
      )}
      <div className="max-w-[85%] rounded-lg rounded-tr-sm border border-border bg-background-1 px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
        {entry.text}
      </div>
    </div>
  );
});

/** The agent's reply, with a caret while it is still arriving. */
export const AssistantMessage = observer(function AssistantMessage({
  entry,
}: {
  entry: AssistantEntry;
}) {
  return (
    <div className="min-w-0 text-sm text-foreground">
      <MarkdownRenderer variant="compact" content={entry.text} className="min-w-0" />
      {entry.streaming && (
        <span
          aria-label="Still writing"
          className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-foreground-muted align-baseline"
        />
      )}
    </div>
  );
});

const NOTICE_STYLES = {
  info: { icon: Info, className: 'text-foreground-info' },
  warning: { icon: TriangleAlert, className: 'text-foreground-warning' },
  error: { icon: XCircle, className: 'text-foreground-destructive' },
} as const;

/** Something the runtime wants to say that is not part of the conversation. */
export const NoticeRow = observer(function NoticeRow({ entry }: { entry: NoticeEntry }) {
  const { icon: Icon, className } = NOTICE_STYLES[entry.level];
  return (
    <div className={cn('flex items-start gap-1.5 text-xs', className)}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap">{entry.text}</span>
    </div>
  );
});
