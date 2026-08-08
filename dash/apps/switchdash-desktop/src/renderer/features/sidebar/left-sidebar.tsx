import { Server, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { isCurrentView, useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { ServersSidebarSection } from '../switch-servers/ServersSidebarSection';
import { LocationsGroupLabel } from './locations-group-label';
import { SidebarPinnedSessionList } from './pinned-session-list';
import { SidebarGroupedList } from './sidebar-grouped-list';
import {
  SidebarContainer,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
} from './sidebar-primitives';
import { SidebarSearchTrigger } from './sidebar-search-trigger';
import { SidebarSpace } from './sidebar-space';
import { UpdateSection } from './update-section';

export const LeftSidebar: React.FC = observer(function LeftSidebar() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();

  return (
    <div className="relative flex h-full flex-col bg-background-tertiary text-foreground-tertiary-muted transition-colors">
      <SidebarSpace />
      <SidebarContainer className="min-h-0 w-full flex-1 border-r-0">
        <SidebarContent className="flex flex-col">
          <SidebarPinnedSessionList />
          <ServersSidebarSection />
          <SidebarGroup className="mb-0 flex min-h-0 flex-1 flex-col">
            <LocationsGroupLabel />
            <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
              <SidebarMenu className="flex min-h-0 flex-1 flex-col">
                <SidebarGroupedList />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarSearchTrigger />
            <SidebarMenuButton
              isActive={
                isCurrentView(currentView, 'remoteHosts') ||
                isCurrentView(currentView, 'remoteHost')
              }
              onClick={() => navigate('remoteHosts')}
              aria-label="Remote hosts"
              className="w-full justify-between"
            >
              <span className="flex items-center gap-2">
                <Server className="h-5 w-5 sm:h-4 sm:w-4" />
                Remote hosts
              </span>
            </SidebarMenuButton>
            <SidebarMenuButton
              isActive={isCurrentView(currentView, 'settings')}
              onClick={() => navigate('settings')}
              aria-label="Settings"
              className="w-full justify-between"
            >
              <span className="flex items-center gap-2">
                <Settings className="h-5 w-5 sm:h-4 sm:w-4" />
                Settings
              </span>
              <BoundShortcut settingsKey="settings" />
            </SidebarMenuButton>
          </SidebarMenu>
        </SidebarFooter>
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <UpdateSection />
        </div>
      </SidebarContainer>
    </div>
  );
});
