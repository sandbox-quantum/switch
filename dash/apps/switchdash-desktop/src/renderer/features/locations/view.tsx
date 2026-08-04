import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { LocationViewWrapper } from '@renderer/features/locations/components/location-view-wrapper';
import { appState } from '@renderer/lib/stores/app-state';
import { LocationTitlebar } from './components/location-titlebar';
import { LocationMainPanel } from './components/main-panel/main-panel';

export const locationView = {
  WrapView: LocationViewWrapper,
  TitlebarSlot: LocationTitlebar,
  MainPanel: LocationMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const locationId =
      typeof params === 'object' && params !== null
        ? (params as { locationId?: unknown }).locationId
        : undefined;
    if (typeof locationId !== 'string') return { ok: false, redirect: 'home' };
    return appState.locations.locations.has(locationId) ||
      appState.locations.pendingCreationIds.has(locationId)
      ? { ok: true }
      : { ok: false, redirect: 'home' };
  },
  // `roomId` records which room the agent was opened *from*, when it was opened
  // from a room in the sidebar. The page itself ignores it; it is what lets the
  // sidebar highlight the row that was clicked rather than every row for that
  // agent, and it travels with history so back/forward stay right.
} satisfies ViewDefinition<{ locationId: string; agentName?: string; roomId?: string }>;
