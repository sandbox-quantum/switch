import { useObserver } from 'mobx-react-lite';
import { useCallback, type ComponentType, type ReactNode } from 'react';
// Type-only, and it must stay that way: importing the registry's value here
// would close a cycle back through every view module. See workspace-slots.ts.
import type { ViewId, WrapParams } from '@renderer/app/view-registry';
import { appState } from '@renderer/lib/stores/app-state';

export type NonSettingsViewId = Exclude<ViewId, 'settings'>;

/**
 * NavArgs makes the params argument optional when all fields are optional,
 * and omits it entirely for views with no params (home, skills).
 */
export type NavArgs<TId extends ViewId> = keyof WrapParams<TId> extends never
  ? [viewId: TId]
  : Partial<WrapParams<TId>> extends WrapParams<TId>
    ? [viewId: TId, params?: WrapParams<TId>]
    : [viewId: TId, params: WrapParams<TId>];

/** Higher-rank navigate function — generic at the call site, not at the hook call site. */
export type NavigateFnTyped = <TId extends ViewId>(...args: NavArgs<TId>) => void;

export type UpdateViewParamsFn = <TId extends ViewId>(
  viewId: TId,
  update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)
) => void;

export type SlotsContextValue = {
  WrapView: ComponentType<{ children: ReactNode } & Record<string, unknown>>;
  TitlebarSlot: ComponentType;
  MainPanel: ComponentType;
  currentView: ViewId;
  lastNonSettingsView: NonSettingsViewId;
};

export type WrapParamsContextValue = {
  wrapParams: Record<string, unknown>;
};

export type ViewParamsStoreContextValue = {
  viewParamsStore: Partial<{ [K in ViewId]: WrapParams<K> }>;
};

export function useNavigate(): { navigate: NavigateFnTyped } {
  const navigate = useCallback((...args: unknown[]) => {
    const [viewId, params] = args as [ViewId, WrapParams<ViewId> | undefined];
    appState.navigation.navigate(viewId, params);
  }, []) as NavigateFnTyped;
  return { navigate };
}

/**
 * The active view id, without consulting the view registry.
 *
 * `useWorkspaceSlots` also reports this, but resolving it there means loading
 * the registry — which view modules cannot do without closing an import cycle.
 * Callers that only need to know *which* view is active should use this.
 */
export function useCurrentViewId(): ViewId {
  return useObserver(() => appState.navigation.currentViewId);
}

export function useWorkspaceWrapParams(): WrapParamsContextValue {
  return useObserver(() => ({
    wrapParams: (appState.navigation.viewParamsStore[appState.navigation.currentViewId] ??
      {}) as Record<string, unknown>,
  }));
}

export function useParams<TId extends ViewId>(
  viewId: TId
): {
  params: WrapParams<TId>;
  setParams: (
    update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)
  ) => void;
} {
  const setParams = useCallback(
    (update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)) => {
      appState.navigation.updateViewParams(viewId, update);
    },
    // viewId is a stable string literal
    [viewId]
  );
  return useObserver(() => ({
    params: (appState.navigation.viewParamsStore[viewId] ?? {}) as WrapParams<TId>,
    setParams,
  }));
}

export function isCurrentView(currentView: string | null | undefined, target: string): boolean {
  return currentView === target;
}
