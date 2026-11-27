import { SectionLabel } from '@switch-console/chat-ui/primitives/label';
import { SidebarGroup, SidebarMenu } from '@switch-console/chat-ui/primitives/sidebar';
import { observer } from 'mobx-react-lite';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarSessionItem } from './session-item';

export const SidebarPinnedSessionList = observer(function SidebarPinnedSessionList() {
  const entries = sidebarStore.pinnedSidebarEntries;
  if (entries.length === 0) return null;

  return (
    <SidebarGroup className="flex shrink-0 flex-col">
      <div className="flex h-[40px] items-center justify-between pr-2.5 pl-5">
        <SectionLabel className="text-foreground-tertiary-passive">Pinned</SectionLabel>
      </div>
      <SidebarMenu className="px-3 pb-2">
        {entries.map(({ locationId, sessionId }) => (
          <SidebarSessionItem
            key={`${locationId}:${sessionId}`}
            locationId={locationId}
            sessionId={sessionId}
            rowVariant="pinned"
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
});
