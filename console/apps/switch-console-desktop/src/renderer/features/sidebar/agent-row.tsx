import { Bot } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { CSSProperties, ReactNode } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { AgentStatusSlot } from './agent-status-slot';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { depthIndent } from './sidebar-store';

/**
 * One agent's row in the sidebar, whoever runs it: an agent this Console runs
 * and a managed agent the server places on a machine look and read the same.
 * What differs is only what goes in the slots: the marks after the provider,
 * the one warning the status slot shows, and the row's own buttons.
 */
export const SidebarAgentRow = observer(function SidebarAgentRow({
  label,
  iconUrl,
  providerId,
  isActive,
  depth,
  onOpen,
  presence,
  dimmed,
  marks,
  status,
  actions,
}: {
  label: string;
  iconUrl: string | null;
  providerId: AgentProviderId | null;
  isActive: boolean;
  depth: number;
  onOpen: () => void;
  /** Whether the agent is running, stopped or in trouble: the dot on its avatar. Null when unknown. */
  presence: AgentPresence | null;
  /** Its machine cannot be reached, so nothing on the row is current. */
  dimmed: boolean;
  /** Shown after the provider mark, such as where the agent runs. */
  marks: ReactNode;
  /** Indicators in order of cause; the first that renders anything is shown. */
  status: ReactNode;
  /** The row's buttons, shown on hover. */
  actions: ReactNode;
}) {
  return (
    <SidebarMenuRow
      className="group/row flex justify-between"
      data-active={isActive || undefined}
      isActive={isActive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
    >
      {/* The indent lives on the content, not the row, so the hover and
          selection highlight still spans the sidebar's full width at every
          depth. */}
      <div className="flex min-w-0 flex-1 items-center gap-[9px]" style={depthIndent(depth)}>
        {/* 21px inside an 18px slot, so the larger circle reads at the same
            weight as the provider glyphs it replaced without growing the row or
            shifting the label. */}
        <span className="relative flex size-[18px] shrink-0 items-center justify-center">
          <span className="-mx-[1.5px] flex shrink-0" style={presence ? PRESENCE_NOTCH : undefined}>
            <AgentAvatar
              name={label}
              iconUrl={iconUrl}
              size={21}
              className={cn('bg-transparent', dimmed && 'opacity-60')}
            />
          </span>
          {presence && <PresenceDot presence={presence} />}
        </span>
        <SidebarMenuAction
          aria-label={`Open agent ${label}`}
          className="flex-initial truncate select-none"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('truncate', dimmed && 'text-foreground-muted')}>{label}</span>
            {/* What the agent runs on. The avatar took the leading slot, so
                without this the row no longer says. Hideable from the Sessions
                menu for a reader who only cares about identity. */}
            {!sidebarStore.hideProviderMark &&
              (providerId ? (
                <AgentIcon id={providerId} size={12} className="h-3 w-3 shrink-0" />
              ) : (
                <Bot className="h-3 w-3 shrink-0 text-foreground-muted" />
              ))}
            {marks}
            <AgentStatusSlot>{status}</AgentStatusSlot>
          </span>
        </SidebarMenuAction>
      </div>
      {actions}
    </SidebarMenuRow>
  );
});

/** What the dot on an agent's avatar says. */
export type AgentPresence = {
  tone: 'running' | 'stopped' | 'problem' | 'pending';
  /** Said on hover: the state, and why when there is a reason. */
  label: string;
};

const DOT_COLOR: Record<AgentPresence['tone'], string> = {
  running: 'bg-foreground-success',
  stopped: 'bg-foreground-warning',
  problem: 'bg-foreground-destructive',
  pending: 'bg-foreground-muted',
};

/**
 * A see-through circle cut from the avatar's corner, a little larger than the
 * dot centred in it, so the dot stands clear on whatever is behind the row.
 * The dot's centre is at 18px of the 21px avatar.
 */
const NOTCH_MASK = 'radial-gradient(circle at 18px 18px, transparent 5px, #000 5.5px)';
const PRESENCE_NOTCH: CSSProperties = { maskImage: NOTCH_MASK, WebkitMaskImage: NOTCH_MASK };

function PresenceDot({ presence }: { presence: AgentPresence }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={presence.label}
            className={cn(
              'absolute -right-[2px] -bottom-[2px] size-[7px] rounded-full',
              DOT_COLOR[presence.tone]
            )}
          />
        }
      />
      <TooltipContent>{presence.label}</TooltipContent>
    </Tooltip>
  );
}
