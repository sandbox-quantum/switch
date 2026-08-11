import { LocationManagerStore } from '@renderer/features/locations/stores/location-manager';
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store';
import { NavigationHistoryStore } from './navigation-history-store';
import { NavigationStore } from './navigation-store';
import { ResourceMonitorStore } from './resource-monitor-store';
import { snapshotRegistry, type SnapshotRegistry } from './snapshot-registry';
import { UpdateStore } from './update-store';

class AppState {
  readonly update: UpdateStore;
  readonly locations: LocationManagerStore;
  readonly sidebar: SidebarStore;
  readonly snapshots: SnapshotRegistry;
  readonly history: NavigationHistoryStore;
  readonly navigation: NavigationStore;
  readonly resourceMonitor: ResourceMonitorStore;

  constructor() {
    this.snapshots = snapshotRegistry;
    this.update = new UpdateStore();
    this.locations = new LocationManagerStore();
    this.sidebar = new SidebarStore(this.locations);
    this.history = new NavigationHistoryStore();
    this.navigation = new NavigationStore();
    this.resourceMonitor = new ResourceMonitorStore();
    snapshotRegistry.register('navigation', () => this.navigation.snapshot);
    snapshotRegistry.register('sidebar', () => this.sidebar.snapshot);
  }
}

export const appState = new AppState();

// Re-export for callers that previously imported sidebarStore from sidebar-store.ts.
export const sidebarStore = appState.sidebar;
