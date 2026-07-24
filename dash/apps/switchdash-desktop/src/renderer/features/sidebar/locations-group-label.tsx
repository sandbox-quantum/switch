import { DoorOpen, Filter, Laptop, ListFilter, Plus, Server, Users } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ComponentType } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { buttonVariants } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { AgentConnectionKind } from '@shared/core/agents/agent-connection';
import { getProvider } from '@shared/core/providers/agent-provider-registry';
import type { SidebarGrouping } from '@shared/view-state';

const CONNECTION_LABEL: Record<AgentConnectionKind, string> = {
  local: 'Local',
  remote: 'Remote',
};

const GROUPING_OPTIONS: {
  value: SidebarGrouping;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { value: 'agent', label: 'Agents', icon: Users },
  { value: 'room', label: 'Rooms', icon: DoorOpen },
];

/**
 * View switcher for the grouped sidebar — a segmented control that shows both
 * groupings (Agents / Rooms) side by side, with the active one highlighted, so
 * the choice is discoverable at a glance rather than hidden behind an icon menu.
 * Observer-wrapped so the active selection updates reactively.
 */
const ViewGroupingToggle = observer(function ViewGroupingToggle() {
  return (
    <ToggleGroup
      size="sm"
      multiple={false}
      value={[sidebarStore.grouping]}
      onValueChange={([value]) => {
        const opt = GROUPING_OPTIONS.find((o) => o.value === value);
        if (opt) sidebarStore.setGrouping(opt.value);
      }}
      aria-label="Group sidebar by"
    >
      {GROUPING_OPTIONS.map((opt) => {
        const OptIcon = opt.icon;
        return (
          <ToggleGroupItem key={opt.value} value={opt.value} aria-label={opt.label}>
            <OptIcon className="mr-1 h-3.5 w-3.5" />
            {opt.label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
});

/**
 * Optional additive filters for the grouped sidebar — a funnel button that opens
 * checkbox sections for run location, agent type, and live-session presence. Only
 * dimensions with matching agents in the active server are offered; a dot on the
 * icon signals that filters are narrowing the tree.
 */
const FilterDropdown = observer(function FilterDropdown() {
  const connections = sidebarStore.availableFilterConnections;
  const providerIds = sidebarStore.availableFilterProviderIds;
  const active = sidebarStore.hasActiveFilters;

  return (
    <DropdownMenu>
      <Tooltip>
        <DropdownMenuTrigger
          render={
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Filter agents"
                  className={buttonVariants({
                    size: 'icon-xs',
                    variant: 'ghost',
                    className: cn(
                      'relative hover:bg-transparent hover:text-foreground',
                      active ? 'text-foreground' : 'text-foreground-muted'
                    ),
                  })}
                >
                  <Filter />
                  {active && (
                    <span className="bg-accent absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full" />
                  )}
                </button>
              }
            />
          }
        />
        <TooltipContent>Filter</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="min-w-52" align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Filter agents</DropdownMenuLabel>
        </DropdownMenuGroup>
        {connections.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs font-normal text-foreground-muted">
              Run location
            </DropdownMenuLabel>
            {connections.map((kind) => (
              <DropdownMenuCheckboxItem
                key={kind}
                checked={sidebarStore.filterConnections.has(kind)}
                onCheckedChange={() => sidebarStore.toggleFilterConnection(kind)}
              >
                {kind === 'remote' ? (
                  <Server className="mr-1.5 h-4 w-4" />
                ) : (
                  <Laptop className="mr-1.5 h-4 w-4" />
                )}
                {CONNECTION_LABEL[kind]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        )}
        {providerIds.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs font-normal text-foreground-muted">
              Agent type
            </DropdownMenuLabel>
            {providerIds.map((id) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={sidebarStore.filterProviderIds.has(id)}
                onCheckedChange={() => sidebarStore.toggleFilterProviderId(id)}
              >
                <AgentIcon id={id} size={16} className="mr-1.5" />
                {getProvider(id)?.name ?? id}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-foreground-muted">
            Session
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={sidebarStore.filterHasLiveSession}
            onCheckedChange={(checked) => sidebarStore.setFilterHasLiveSession(checked)}
          >
            Has running session
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!active} onClick={() => sidebarStore.clearFilters()}>
          Clear filters
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export const LocationsGroupLabel = observer(function LocationsGroupLabel() {
  const showAddLocationModal = useShowModal('addAgentModal');

  return (
    <div className="flex h-[40px] items-center justify-between pr-2.5 pl-2.5">
      <ViewGroupingToggle />
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <DropdownMenuTrigger
              render={
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Sort agents"
                      className={buttonVariants({
                        size: 'icon-xs',
                        variant: 'ghost',
                        className:
                          'hover:bg-transparent text-foreground-muted hover:text-foreground',
                      })}
                    >
                      <ListFilter />
                    </button>
                  }
                />
              }
            />
            <TooltipContent>Sort by</TooltipContent>
          </Tooltip>
          <DropdownMenuContent className="min-w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sidebarStore.sessionSortBy}>
                <DropdownMenuRadioItem
                  value="created-at"
                  onClick={() => sidebarStore.applySort('created-at')}
                >
                  Created at
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="updated-at"
                  onClick={() => sidebarStore.applySort('updated-at')}
                >
                  Last used
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <FilterDropdown />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => showAddLocationModal({})}
                aria-label="Add Agent"
                className={buttonVariants({
                  size: 'icon-xs',
                  variant: 'ghost',
                  className: 'hover:bg-transparent text-foreground-muted hover:text-foreground',
                })}
              >
                <Plus />
              </button>
            }
          />
          <TooltipContent>
            Add Agent
            <BoundShortcut settingsKey="newLocation" variant="badge" />
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
});
