import { useObserver } from 'mobx-react-lite';
import { Fragment, type ComponentType, type ReactNode } from 'react';
import { views, type ViewDefinition } from '@renderer/app/view-registry';
import type { SlotsContextValue } from '@renderer/lib/layout/navigation-provider';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * Resolve the active view's slots from the view registry.
 *
 * Kept out of navigation-provider deliberately. This is the only navigation
 * hook that needs the registry's *value*, and view modules import
 * navigation-provider for `useNavigate` / `useParams`. Holding this here too
 * closed a cycle — view-registry → a view → navigation-provider → view-registry
 * — that made the registry's own initialisation order load-order dependent, and
 * it would intermittently evaluate the `views` object while one of the view
 * bindings it reads was still in its temporal dead zone.
 */
export function useWorkspaceSlots(): SlotsContextValue {
  return useObserver(() => {
    const viewId = appState.navigation.currentViewId;
    const registry = views as unknown as Record<string, ViewDefinition<Record<string, unknown>>>;
    const viewDef = registry[viewId];
    const def = viewDef ?? registry.home;
    const resolvedViewId = viewDef ? viewId : 'home';
    return {
      WrapView: (def.WrapView ?? Fragment) as ComponentType<
        { children: ReactNode } & Record<string, unknown>
      >,
      TitlebarSlot: def.TitlebarSlot ?? (() => null),
      MainPanel: def.MainPanel,
      currentView: resolvedViewId,
      lastNonSettingsView: appState.navigation.lastNonSettingsView,
    };
  });
}
