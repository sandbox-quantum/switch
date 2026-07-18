import { makeAutoObservable } from 'mobx';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import type { LocationViewSnapshot } from '@shared/view-state';

export type LocationView = 'sessions' | 'subagents' | 'settings';

export class LocationViewStore implements Snapshottable<LocationViewSnapshot> {
  activeView: LocationView = 'sessions';
  sessionView: SessionViewStore = new SessionViewStore();

  constructor() {
    makeAutoObservable(this);
  }

  setLocationView(view: LocationView) {
    this.activeView = view;
  }

  get snapshot(): LocationViewSnapshot {
    return {
      activeView: this.activeView,
      sessionViewTab: this.sessionView.tab,
    };
  }

  restoreSnapshot(snapshot: Partial<LocationViewSnapshot>): void {
    if (snapshot.activeView) this.activeView = snapshot.activeView as LocationView;
    if (snapshot.sessionViewTab) this.sessionView.setTab(snapshot.sessionViewTab);
  }
}

class SessionViewStore {
  tab: 'active' | 'archived' = 'active';
  searchQuery: string = '';
  selectedIds: Set<string> = new Set();
  lastSelectedId: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  setTab(tab: 'active' | 'archived') {
    this.tab = tab;
  }

  setSearchQuery(query: string) {
    this.searchQuery = query;
  }

  setSelectedIds(ids: Set<string>) {
    this.selectedIds = ids;
    this.lastSelectedId = null;
  }

  toggleSelect(id: string) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    this.lastSelectedId = id;
  }

  selectRange(orderedIds: string[], toId: string) {
    const anchor = this.lastSelectedId;
    if (!anchor || anchor === toId) {
      this.toggleSelect(toId);
      return;
    }
    const fromIndex = orderedIds.indexOf(anchor);
    const toIndex = orderedIds.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) {
      this.toggleSelect(toId);
      return;
    }
    const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
    this.selectedIds = new Set(orderedIds.slice(start, end + 1));
  }
}
