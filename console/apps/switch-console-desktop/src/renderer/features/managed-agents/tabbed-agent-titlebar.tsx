import type { ReactNode } from 'react';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { cn } from '@renderer/utils/utils';
import type { AgentTab } from './agent-tab-store';
import type { AgentTabOption } from './agent-tabs';

/**
 * A tabbed agent's titlebar: its crumb and tabs on the left, `rightSlot` on
 * the right. On Chats the left side is as wide as the chat list below it, so
 * the two line up; on the other tabs it takes the width it needs. Either way
 * the tabs keep their width and a long name is what gives way.
 */
export function TabbedAgentTitlebar({
  breadcrumb,
  tab,
  tabs,
  onTab,
  rightSlot,
}: {
  breadcrumb: ReactNode;
  tab: AgentTab;
  tabs: readonly AgentTabOption[];
  onTab: (tab: AgentTab) => void;
  rightSlot: ReactNode;
}) {
  return (
    <Titlebar
      className="border-b border-border"
      leftClassName={cn(
        'min-w-0 self-stretch',
        tab === 'chats' && 'w-[300px] shrink-0 border-r border-border'
      )}
      leftSlot={
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 truncate">{breadcrumb}</div>
          <SegmentedControl
            className="shrink-0"
            value={tab}
            onChange={onTab}
            options={tabs}
            ariaLabel="Agent view"
          />
        </div>
      }
      rightClassName="min-w-0 flex-1 justify-between gap-3 pl-4"
      rightSlot={rightSlot}
    />
  );
}
