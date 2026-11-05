import {
  Archive,
  ArchiveRestore,
  Bot,
  Lock,
  MessagesSquare,
  MoreVertical,
  User,
} from 'lucide-react';
import { roomTitle } from '@renderer/features/switch-rooms/room-labels';
import { ACCESS_LABELS } from '@renderer/features/switch-rooms/room-settings-sections';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { ACCESS_SHORT, countText, ownerText, type RoomCard as RoomCardData } from './room-list';

/** The mark of an app connection: its platform's icon, or Switch Console's. */
export function AppMark({ bridgeType, size = 14 }: { bridgeType: string | null; size?: number }) {
  return hasBridgeIcon(bridgeType) ? (
    <BridgeIcon bridgeType={bridgeType} size={size} className="shrink-0" />
  ) : (
    <MessagesSquare
      className="shrink-0 text-foreground-muted"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * One room on the Rooms page. The whole card opens it; the menu at its top
 * right holds what can be done from here (archiving), and is there only when
 * the server lets you.
 */
export function RoomCard({
  card,
  unread,
  showYours,
  onOpen,
  onArchive,
}: {
  card: RoomCardData;
  /** Messages here you have not read, as the sidebar counts them; 0 for none. */
  unread: number;
  /** Marks your rooms "Yours": in All rooms, where they sit among everyone's. */
  showYours: boolean;
  onOpen: () => void;
  /** Archives the room, or unarchives an archived one; null when you may not. */
  onArchive: (() => void) | null;
}) {
  const owner = ownerText(card);
  return (
    <div
      data-room-card={card.id}
      className="group relative flex h-full min-h-[168px] flex-col rounded-[11px] border border-border bg-background transition-colors hover:border-border-1"
    >
      <button
        type="button"
        aria-label={`Open ${card.name}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />
      <div className="pointer-events-none flex flex-1 flex-col gap-2 p-4">
        <div className={`flex items-center gap-2${onArchive ? ' pr-8' : ''}`}>
          <span className="relative flex shrink-0">
            <AppMark bridgeType={card.bridgeType} size={18} />
            {card.privateChannel && (
              <span
                role="img"
                aria-label="Private"
                title="Only the people in it can reach it"
                className="absolute -right-1.5 -bottom-1.5 flex size-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border"
              >
                <Lock className="size-2 text-foreground" />
              </span>
            )}
          </span>
          {/* A channel reads as one, `#name`, as it does in the sidebar and the room's title. */}
          <h3 className="min-w-0 truncate font-medium text-foreground">
            {roomTitle({ name: card.name, bridgeType: card.bridgeType })}
          </h3>
          {showYours && card.mine && <Badge variant="secondary">Yours</Badge>}
        </div>
        <p className="line-clamp-2 text-sm text-foreground-muted">
          {card.description || <span className="italic">No description.</span>}
        </p>
        <p className="flex min-w-0 items-center gap-1 text-xs text-foreground-muted">
          <AppMark bridgeType={card.bridgeType} size={12} />
          <span className="truncate">
            {[card.appLabel, card.groupName].filter(Boolean).join(' · ')}
          </span>
          {card.access && (
            <>
              <span aria-hidden>·</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="pointer-events-auto relative">
                      {ACCESS_SHORT[card.access]}
                    </span>
                  }
                />
                <TooltipContent>{ACCESS_LABELS[card.access]}</TooltipContent>
              </Tooltip>
            </>
          )}
        </p>
        <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-2.5 text-xs text-foreground-muted">
          {owner && <span className="truncate">{owner}</span>}
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Bot className="size-3.5" />
              {countText(card.agentCount, 'agent', 'agents')}
            </span>
            {card.peopleCount !== null && (
              <span className="flex items-center gap-1">
                <User className="size-3.5" />
                {countText(card.peopleCount, 'person', 'people')}
              </span>
            )}
            {unread > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="pointer-events-auto relative ml-auto rounded-full bg-primary-button-background px-2 py-0.5 text-[11px] leading-none font-medium text-primary-button-foreground tabular-nums">
                      {unreadText(unread)}
                    </span>
                  }
                />
                <TooltipContent>
                  {unread === 1
                    ? '1 message you haven’t read'
                    : `${unread} messages you haven’t read`}
                </TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
      </div>
      {onArchive && (
        <div className="absolute top-2.5 right-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  aria-label={`${card.name} actions`}
                >
                  <MoreVertical className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
              <DropdownMenuItem onClick={onArchive}>
                {card.archived ? (
                  <ArchiveRestore className="size-4" />
                ) : (
                  <Archive className="size-4" />
                )}
                {card.archived ? 'Unarchive' : 'Archive'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

/** "3 unread", or "99+ unread" past that: the word says what the number counts. */
export function unreadText(count: number): string {
  return `${count > 99 ? '99+' : count} unread`;
}
