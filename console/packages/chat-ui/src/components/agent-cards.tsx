import { MoreVertical, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';

/**
 * The grid an agents page lays its cards in: four columns at the design's
 * content width, reflowing narrower rather than squashing. The cards' height is
 * a floor rather than a ratio, so a card keeps its shape as the column width
 * changes.
 */
export function AgentCardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-[14px]">
      {children}
    </div>
  );
}

/**
 * The add tile that leads the grid rather than sitting as a button in the page
 * header: it is the same kind of thing as the cards after it, and on an empty
 * page it is the only thing on screen, which says what to do without needing an
 * empty-state sentence.
 */
export function AddAgentTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[184px] cursor-pointer items-center justify-center rounded-[11px] border border-dashed border-border text-foreground-muted transition-colors hover:border-border-1 hover:bg-[var(--sel-soft)] hover:text-foreground"
      aria-label="Add agent"
    >
      <Plus className="size-5" />
    </button>
  );
}

export function AgentCard({
  label,
  avatar,
  detail,
  note,
  footer,
  actions,
  onOpen,
}: {
  label: string;
  avatar: ReactNode;
  /** Under the name, such as what runs it and where. */
  detail: string;
  /** A fainter line under the detail, such as who it belongs to. */
  note: string | null;
  /** The card's last row, such as its status. */
  footer: ReactNode;
  /** The items of the card's actions menu, shown on hover; null for none. */
  actions: ReactNode;
  onOpen: () => void;
}) {
  return (
    <div className="group relative flex min-h-[184px] flex-col rounded-[11px] bg-[var(--surface-2)] transition-colors hover:bg-[var(--fill)]">
      {/* One real button covering the card, so the whole tile is the target and
          screen readers get a single named control rather than a grid of
          nested ones. The visible content below it is inert; the actions after
          it sit on top and keep their own clicks. */}
      <button
        type="button"
        aria-label={`Open ${label}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />

      <div className="pointer-events-none flex flex-1 flex-col p-[14px]">
        <div className="flex flex-1 items-center justify-center py-3">{avatar}</div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{label}</div>
          <div className="truncate text-xs text-foreground-muted">{detail}</div>
          {note && <div className="truncate text-xs text-foreground-tertiary-passive">{note}</div>}
        </div>
      </div>

      {footer}

      {actions && (
        <div className="absolute top-2 right-2 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" aria-label={`${label} actions`}>
                  <MoreVertical className="size-3" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">{actions}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
