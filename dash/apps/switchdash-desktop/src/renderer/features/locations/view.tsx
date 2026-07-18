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
} satisfies ViewDefinition<{ locationId: string; subagentName?: string }>;
