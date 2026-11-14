import { observer } from 'mobx-react-lite';
import { useChatHost } from '../host';

/** How many of a room's messages wait to be read, as a small count; nothing when none do. */
export const UnreadBadge = observer(function UnreadBadge({ roomId }: { roomId: string }) {
  const count = useChatHost().chats.unread(roomId);
  if (count === 0) return null;
  return (
    <span
      aria-label={`${count} unread`}
      className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary-button-background px-1 text-[10px] leading-none font-medium text-primary-button-foreground tabular-nums"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
});
