import { Bot, DoorClosed, Grid2x2, MoreHorizontal } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../model/cn';
import { kindOf, type TemplateKind } from '../model/template-filters';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { SwitchConsoleMark } from '../primitives/switch-console-mark';

export const KIND_ICON: Record<TemplateKind, typeof Bot> = {
  agent: Bot,
  room: DoorClosed,
  group: Grid2x2,
};

export const KIND_LABEL: Record<TemplateKind, string> = {
  agent: 'Agent',
  room: 'Room',
  group: 'Group',
};

// A tint in one corner, faded into the card by a wash of its own background so
// it reads in either theme: warm for what comes with Switch, cool for the rest.
const veil = (direction: string, from: string, to: string) =>
  `linear-gradient(${direction}, color-mix(in srgb, var(--background) 90%, transparent) ${from}, transparent ${to})`;

const OFFICIAL_TINT: CSSProperties = {
  backgroundColor: 'var(--background)',
  backgroundImage: [
    veil('to bottom', '30%', '100%'),
    'radial-gradient(130% 150% at 0% 100%, rgb(255 137 94 / 0.16), rgb(208 169 152 / 0.16) 35%, rgb(161 201 210 / 0.16) 70%, transparent)',
  ].join(', '),
};

const WORKSPACE_TINT: CSSProperties = {
  backgroundColor: 'var(--background)',
  backgroundImage: [
    veil('to bottom', '30%', '100%'),
    'radial-gradient(130% 150% at 0% 100%, rgb(213 191 233 / 0.1) 17%, rgb(186 197 236 / 0.1) 78%, transparent)',
  ].join(', '),
};

/** What a card shows of a template; each app maps its own record onto it. */
export type TemplateCardData = {
  name: string;
  kind: string;
  official: boolean;
  /** Who made it, for one that is not official. */
  creator: string;
  description: string;
};

export function TemplateCard({
  template,
  onOpen,
  actions,
}: {
  template: TemplateCardData;
  onOpen: () => void;
  /** The items of the card's actions menu; null when the signed-in user may do nothing more with it. */
  actions: ReactNode;
}) {
  const kind = kindOf(template.kind);
  const Icon = KIND_ICON[kind];
  return (
    <div
      className="group relative flex h-[164px] flex-col gap-2 rounded-2xl border border-border px-4 pt-4 pb-8 transition-colors hover:border-border-1"
      style={template.official ? OFFICIAL_TINT : WORKSPACE_TINT}
    >
      <button
        type="button"
        aria-label={`Open ${template.name}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-2xl focus-visible:ring-2 focus-visible:outline-none"
        onClick={onOpen}
      />
      <div className="pointer-events-none flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[19px] font-bold tracking-[-0.02em] text-foreground">
          {template.name}
        </h3>
        <Icon className="size-6 shrink-0 text-foreground" strokeWidth={1.5} aria-hidden />
      </div>
      <div className="pointer-events-none flex min-w-0 flex-col gap-2">
        <div className="flex flex-col gap-1 text-[13px] font-medium text-foreground/70">
          <span className="truncate">{KIND_LABEL[kind]}</span>
          {template.official ? (
            <span className="flex items-center gap-1">
              <SwitchConsoleMark size={12} />
              Switch AI
            </span>
          ) : (
            <span className="truncate">{template.creator}</span>
          )}
        </div>
        {template.description && (
          <p className="line-clamp-2 text-sm text-foreground-muted">{template.description}</p>
        )}
      </div>
      {actions && (
        <div
          className={cn(
            'absolute right-2 bottom-2 opacity-0 transition-opacity',
            'group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100'
          )}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  aria-label={`${template.name} actions`}
                >
                  <MoreHorizontal className="size-4" />
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
