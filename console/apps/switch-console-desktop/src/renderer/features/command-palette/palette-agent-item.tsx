import { Command } from 'cmdk';
import { Bot } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useAgentIconUrl } from '@renderer/lib/stores/use-remote-agents';
import type { SearchItem } from '@shared/core/search';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';

/**
 * An agent row, laid out like the sidebar's (`sidebar/agent-item.tsx`): the
 * agent's own face leads, and what it runs on follows its name as a small mark.
 *
 * A row of its own rather than a branch of `PaletteKindIcon`, because the
 * chosen icon comes from a query keyed by server and a hook cannot be called
 * from inside a switch. An agent this app does not hold — a hit whose local row
 * has gone — still gets the bot drawn from its name, which is the same face the
 * Switch bridges show.
 */
export const PaletteAgentItem = observer(function PaletteAgentItem({
  item,
  value,
  onSelect,
}: {
  item: SearchItem;
  value: string;
  onSelect: () => void;
}) {
  const agent = agentsStore.agentById(item.id);
  const iconUrl = useAgentIconUrl(agent?.serverId ?? null, agent?.switchAgentId ?? null);

  return (
    <Command.Item value={value} onSelect={onSelect} className={PALETTE_ITEM_CLASS}>
      {/* 16px inside a 14px slot, so the circle carries the same weight as the
          glyphs on the other rows without widening the icon column. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <AgentAvatar
          name={item.title}
          iconUrl={iconUrl}
          size={16}
          className="-mx-px bg-transparent"
        />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">{item.title}</span>
        {!sidebarStore.hideProviderMark &&
          (agent?.providerId ? (
            <AgentIcon id={agent.providerId} size={12} className="h-3 w-3 shrink-0" />
          ) : (
            <Bot className="h-3 w-3 shrink-0 text-foreground-muted" />
          ))}
      </span>
    </Command.Item>
  );
});
