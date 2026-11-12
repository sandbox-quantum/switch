import { DoorOpen, FileText, Link2, MoreVertical, Package, Trash2 } from 'lucide-react';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { LibraryItem } from '@shared/core/switch-servers/library';
import {
  ACCESS_SHORT,
  accessOf,
  LIBRARY_ACCESS_OPTIONS,
  ownerText,
  packageContentsText,
  roomsText,
} from './library-model';

/**
 * One reference or document on the Library page. The whole card opens it; the
 * menu at its top right deletes it, and is there only for its owner and admins.
 * A reference's links stay on its page: they may be private.
 */
export function LibraryCard({
  item,
  viewerId,
  showYours,
  onOpen,
  onDelete,
}: {
  item: LibraryItem;
  viewerId: string | null;
  /** Marks your items "Yours": in All, where they sit among everyone's. */
  showYours: boolean;
  onOpen: () => void;
  /** Null when you may not delete it. */
  onDelete: (() => void) | null;
}) {
  const Icon = item.kind === 'references' ? Link2 : item.kind === 'packages' ? Package : FileText;
  // What a package holds stands where a reference's type does.
  const kindLine = item.kind === 'packages' ? packageContentsText(item) : item.typeLabel;
  const mine = viewerId !== null && item.ownerId === viewerId;
  const access = accessOf(item);
  const owner = ownerText(item, viewerId);
  return (
    <div
      data-library-card={item.id}
      className="group relative flex h-full min-h-[150px] flex-col rounded-[11px] border border-border bg-background transition-colors hover:border-border-1"
    >
      <button
        type="button"
        aria-label={`Open ${item.name}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />
      <div className="pointer-events-none flex flex-1 flex-col gap-2 p-4">
        <div className={`flex items-center gap-2${onDelete ? ' pr-8' : ''}`}>
          <Icon className="size-4.5 shrink-0 text-foreground-muted" />
          <h3 className="min-w-0 truncate font-medium text-foreground">{item.name}</h3>
          {showYours && mine && <Badge variant="secondary">Yours</Badge>}
        </div>
        <p className="line-clamp-2 text-sm text-foreground-muted">
          {item.description || <span className="italic">No description.</span>}
        </p>
        <p className="flex min-w-0 items-center gap-1 text-xs text-foreground-muted">
          {kindLine && (
            <>
              <span className="truncate">{kindLine}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <Tooltip>
            <TooltipTrigger
              render={<span className="pointer-events-auto relative">{ACCESS_SHORT[access]}</span>}
            />
            <TooltipContent>
              {LIBRARY_ACCESS_OPTIONS.find((option) => option.value === access)?.hint}
            </TooltipContent>
          </Tooltip>
        </p>
        <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-2.5 text-xs text-foreground-muted">
          {owner && <span className="truncate">{owner}</span>}
          <span className="flex items-center gap-1">
            <DoorOpen className="size-3.5" />
            {roomsText(item.attachedRoomsCount)}
          </span>
        </div>
      </div>
      {onDelete && (
        <div className="absolute top-2.5 right-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  aria-label={`${item.name} actions`}
                >
                  <MoreVertical className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-4" />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
