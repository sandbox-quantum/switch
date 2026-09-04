import { Info, TriangleAlert, XCircle } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { cn } from '@renderer/utils/utils';
import type { TranscriptEntry } from '@shared/core/sessions/session-transcript';

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>;
type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>;
type NoticeEntry = Extract<TranscriptEntry, { kind: 'notice' }>;

const SOURCE_TAGS = { room: 'from room', system: 'system' } as const;

/** A room id is no use as a label; the leading segment at least distinguishes
 *  one room from another until the name is known. */
function shortRoomId(roomId: string): string {
  const bare = roomId.replace(/^[!#]/, '');
  const local = bare.split(':')[0] ?? bare;
  return local.length > 8 ? `${local.slice(0, 8)}…` : local;
}

/**
 * A message from a person — or, when it came over a room, from whoever
 * addressed the agent there. Set apart from the agent's own replies by
 * alignment and a surface rather than a name, which would be a name per
 * message for a conversation that only ever has two sides.
 *
 * A room message is the exception: it has a sender and a place, and the text
 * the agent was actually sent is a Switch envelope wrapped around ids nobody
 * reading this needs. So the header names them and the body is what was typed.
 */
export const UserMessage = observer(function UserMessage({ entry }: { entry: UserEntry }) {
  const room = entry.room;
  const tag = entry.source === 'console' || room ? null : SOURCE_TAGS[entry.source];
  return (
    <div className="flex flex-col items-end gap-1">
      {tag && (
        <span className="text-tiny tracking-wide text-foreground-passive uppercase">{tag}</span>
      )}
      {room && (
        <span className="text-tiny text-foreground-passive">
          {room.sender} · #{room.roomName ?? shortRoomId(room.roomId)}
        </span>
      )}
      <div className="max-w-[85%] rounded-lg rounded-tr-sm border border-border bg-background-1 px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
        {entry.displayText ?? entry.text}
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
