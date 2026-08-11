import { Command } from 'cmdk';
import { MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { AgentStatusIndicator } from '@renderer/features/sessions/components/agent-status-indicator';
import { sessionAgentStatus } from '@renderer/features/sessions/stores/session-selectors';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';

export const PaletteSessionItem = observer(function PaletteSessionItem({
  sessionStore,
  value,
  onSelect,
}: {
  sessionStore: SessionStore;
  value: string;
  onSelect: () => void;
}) {
  const status = sessionAgentStatus(sessionStore);

  return (
    <Command.Item value={value} onSelect={onSelect} className={PALETTE_ITEM_CLASS}>
      {/* Matches the sidebar's session row (`sidebar/session-item.tsx`). */}
      <MessageSquare size={14} className="shrink-0 text-foreground/40" />
      <span className="flex-1 truncate">{sessionStore.data.title}</span>
      <AgentStatusIndicator status={status} disableTooltip />
    </Command.Item>
  );
});
