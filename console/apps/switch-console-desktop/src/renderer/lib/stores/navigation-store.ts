import { makeAutoObservable, toJS } from 'mobx';
import { type GuardResult, type ViewId, type WrapParams } from '@renderer/app/view-registry';
import type { NonSettingsViewId } from '@renderer/lib/layout/navigation-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { report } from '@renderer/lib/telemetry/report';
import type { NavigationSnapshot } from '@shared/view-state';
import { appState } from './app-state';
import type { Snapshottable } from './snapshottable';

type ViewParamsStore = Partial<{ [K in ViewId]: WrapParams<K> }>;

export class NavigationStore implements Snapshottable<NavigationSnapshot> {
  currentViewId: ViewId = 'home';
  viewParamsStore: ViewParamsStore = {};
  isNavigating: boolean = false;
  lastNonSettingsView: NonSettingsViewId = 'home';

  private readonly _guards = new Map<ViewId, (params: unknown) => GuardResult>();
  private readonly _registeredViewIds = new Set<ViewId>();

  constructor() {
    makeAutoObservable(this);
  }

  registerView(viewId: ViewId): void {
    this._registeredViewIds.add(viewId);
  }

  isRegisteredViewId(value: unknown): value is ViewId {
    return typeof value === 'string' && this._registeredViewIds.has(value as ViewId);
  }

  registerGuard(viewId: ViewId, guard: (params: unknown) => GuardResult): void {
    this._guards.set(viewId, guard);
  }

  private _runGuard(viewId: ViewId, params: unknown): GuardResult {
    return this._guards.get(viewId)?.(params) ?? { ok: true };
  }

  private _clearViewParams(viewId: ViewId): void {
    if (this.viewParamsStore[viewId] === undefined) return;
    const next = { ...this.viewParamsStore };
    delete next[viewId];
    this.viewParamsStore = next;
  }

  revalidate(): void {
    const result = this._runGuard(this.currentViewId, this.viewParamsStore[this.currentViewId]);
    if (!result.ok) {
      if (result.discardParams) this._clearViewParams(this.currentViewId);
      this._applyNavigation(result.redirect, result.params as WrapParams<ViewId>);
    }
  }

  navigate<T extends ViewId>(viewId: T, params?: WrapParams<T>): void {
    const historyParams = params ?? this.viewParamsStore[viewId] ?? ({} as WrapParams<T>);
    appState.history.push({ kind: 'view', viewId, params: historyParams });
    this._applyNavigation(viewId, params);
  }

  _applyNavigation<T extends ViewId>(viewId: T, params?: WrapParams<T>): void {
    const resolvedParams = params ?? this.viewParamsStore[viewId];
    const guard = this._runGuard(viewId, resolvedParams);
    if (!guard.ok) {
      if (guard.discardParams && params === undefined) this._clearViewParams(viewId);
      this._applyNavigation(guard.redirect, guard.params as WrapParams<typeof guard.redirect>);
      return;
    }

    if (viewId !== this.currentViewId) {
      // Inside the changed check: re-navigating to the screen you are already on
      // is not opening it, and counting it would make the busiest view the one
      // people revisit rather than the one they use.
      report('view_opened', { view_id: viewId });
      this.currentViewId = viewId;
      if (viewId !== 'settings') {
        this.lastNonSettingsView = viewId;
      }
      this.isNavigating = true;
    }
    if (params !== undefined) {
      this.viewParamsStore = { ...this.viewParamsStore, [viewId]: params };
    }
    modalStore.closeModal();
  }

  updateViewParams<TId extends ViewId>(
    viewId: TId,
    update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)
  ): void {
    const current = (this.viewParamsStore[viewId] ?? {}) as WrapParams<TId>;
    const next = typeof update === 'function' ? update(current) : { ...current, ...update };
    this.viewParamsStore = { ...this.viewParamsStore, [viewId]: next };
  }

  get snapshot(): NavigationSnapshot {
    return {
      currentViewId: this.currentViewId,
      viewParams: toJS(this.viewParamsStore) as Record<string, unknown>,
    };
  }

  restoreSnapshot(snapshot: Partial<NavigationSnapshot>): void {
    if (this.isRegisteredViewId(snapshot.currentViewId)) {
      this.currentViewId = snapshot.currentViewId;
      if (snapshot.currentViewId !== 'settings') {
        this.lastNonSettingsView = snapshot.currentViewId as NonSettingsViewId;
      }
    }
    if (snapshot.viewParams) {
      const filtered: ViewParamsStore = {};
      for (const [key, value] of Object.entries(snapshot.viewParams)) {
        if (this.isRegisteredViewId(key)) {
          (filtered as Record<ViewId, unknown>)[key] = value;
        }
      }
      this.viewParamsStore = filtered;
    }

    // Validate after params are loaded so the guard has full context.
    const guard = this._runGuard(this.currentViewId, this.viewParamsStore[this.currentViewId]);
    if (!guard.ok) {
      if (guard.discardParams) this._clearViewParams(this.currentViewId);
      this.currentViewId = guard.redirect;
      if (guard.redirect !== 'settings') {
        this.lastNonSettingsView = guard.redirect as NonSettingsViewId;
      }
      if (guard.params !== undefined) {
        this.viewParamsStore = { ...this.viewParamsStore, [guard.redirect]: guard.params };
      }
    }

    // The screen a session resumes on is arrived at rather than navigated to, so
    // `_applyNavigation` never sees it and nobody would be counted as having
    // opened it — someone who works all afternoon in a restored session would
    // report no screen at all. Reported once, here at the end, so a snapshot the
    // guard sends back counts the screen the user lands on rather than both it
    // and the one that was persisted. `currentViewId` has settled by now, which
    // is also what keeps a later navigation to the same screen from counting a
    // second opening.
    report('view_opened', { view_id: this.currentViewId });
  }
}
