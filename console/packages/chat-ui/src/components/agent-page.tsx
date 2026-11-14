import { ChevronDown, ChevronRight, type LucideIcon, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AgentAvatar } from '../host';
import { cn } from '../model/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { SidebarItemMiniButton } from '../primitives/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '../primitives/tooltip';

/** Where an agent runs, as the one line under its name says it. */
export type AgentLine = {
  icon: LucideIcon;
  /** The machine, or whatever the line names. */
  text: string;
  /** How the agent is doing there when that needs saying; null when it runs fine. */
  status: string | null;
  /** Hover text, saying more than fits on the line. */
  title: string;
};

/**
 * The top of an agent's page: its picture, its name and the line under it.
 * With `onOpenLine` the line is a quiet link; `children` go under it, such
 * as buttons to the agent's own sections.
 */
export function AgentProfileHeader({
  name,
  iconUrl,
  serverId,
  line,
  onOpenLine,
  children,
}: {
  name: string;
  iconUrl: string | null;
  serverId: string;
  line: AgentLine | null;
  onOpenLine: (() => void) | null;
  children?: ReactNode;
}) {
  const LineIcon = line?.icon;
  return (
    <div className="flex flex-col items-center px-2 pt-4 pb-6 text-center">
      <span className="flex size-24 shrink-0 items-center justify-center rounded-[22%] bg-background-2">
        <AgentAvatar name={name} iconUrl={iconUrl} serverId={serverId} size={76} />
      </span>
      <h2 className="mt-4 max-w-full truncate text-base font-semibold text-foreground">{name}</h2>
      {line && LineIcon && (
        <p
          className="mt-0.5 flex max-w-full items-center gap-1.5 text-sm text-foreground-muted"
          title={line.title}
        >
          {onOpenLine ? (
            // A quiet link: muted until hovered, so the line reads as a fact
            // first. Only the machine is the link, not how the agent is doing.
            <button
              type="button"
              onClick={onOpenLine}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
            >
              <LineIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{line.text}</span>
            </button>
          ) : (
            <>
              <LineIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{line.text}</span>
            </>
          )}
          {line.status && <span className="shrink-0">· {line.status}</span>}
        </p>
      )}
      {children}
    </div>
  );
}

/** A titled list on an agent's page, folded by its title, with a button to add to it. */
export function ConversationSection({
  title,
  addLabel,
  onAdd,
  addChoices,
  children,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  /** Ways to add, offered as a menu on the button instead of `onAdd`; null for just `onAdd`. */
  addChoices: { label: string; onSelect: () => void }[] | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={title} className="flex flex-col gap-[2px] pb-3">
      <div className="flex items-center justify-between pr-1 pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-xs font-medium text-foreground-muted hover:text-foreground"
        >
          <Chevron className="size-3.5" />
          {title}
        </button>
        {addChoices ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarItemMiniButton aria-label={addLabel} title={addLabel}>
                  <Plus className="size-3.5" />
                </SidebarItemMiniButton>
              }
            />
            <DropdownMenuContent align="end">
              {addChoices.map((choice) => (
                <DropdownMenuItem key={choice.label} onClick={choice.onSelect}>
                  {choice.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <SidebarItemMiniButton aria-label={addLabel} title={addLabel} onClick={onAdd}>
            <Plus className="size-3.5" />
          </SidebarItemMiniButton>
        )}
      </div>
      {open && children}
    </section>
  );
}

/** A quiet line in a section: empty, loading, or what went wrong. */
export function ConversationNote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-foreground-muted">{children}</p>;
}

/** One of the square buttons under an agent's name, its label in a tooltip. */
export function ProfileButton({
  label,
  icon: Icon,
  onClick,
  pressed,
  disabled = false,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  /** For a section: whether it is the one open. Absent for an action. */
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              'flex size-9 items-center justify-center rounded-lg bg-background-2 text-foreground-muted transition-colors hover:bg-background-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
              pressed && 'bg-background-3 text-foreground ring-1 ring-border-1 ring-inset'
            )}
          >
            <Icon className="size-4" />
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
