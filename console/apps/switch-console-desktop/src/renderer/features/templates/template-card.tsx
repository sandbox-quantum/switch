import { Bot, DoorClosed, Grid2x2, MoreHorizontal, Trash2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import { SwitchConsoleMark } from '@renderer/lib/switch-console-mark';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { cn } from '@renderer/utils/utils';
import { kindOf, type TemplateKind } from './template-filters';

export const KIND_ICON: Record<TemplateKind, typeof Bot> = {
  agent: Bot,
  room: DoorClosed,
  group: Grid2x2,
};

const KIND_LABEL: Record<TemplateKind, string> = {
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

export function TemplateCard({
  template,
  onOpen,
  onDelete,
}: {
  template: StoredTemplateSummary;
  onOpen: () => void;
  /** Null when the signed-in user may not delete it. */
  onDelete: (() => void) | null;
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
      {onDelete && (
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
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-4" />
                Delete template…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
