import type { ComponentType, ReactNode } from 'react';
import { homeView } from '@renderer/app/home-view';
import { locationView } from '@renderer/features/locations/view';
import { sessionView } from '@renderer/features/sessions/view';
import { settingsView } from '@renderer/features/settings/settings-view';
import { roomView } from '@renderer/features/switch-rooms/view';
import { serverView } from '@renderer/features/switch-servers/view';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { appState } from '@renderer/lib/stores/app-state';

// switchdash views: agents-at-a-location (location), sessions (session), home, settings,
// server (a connected Switch gateway). Automations, library, skills, and mcp
// were removed.
export const views = {
  home: homeView,
  location: locationView,
  session: sessionView,
  room: roomView,
  settings: settingsView,
  server: serverView,
  // oxlint-disable-next-line typescript/no-explicit-any
} satisfies Record<string, ViewDefinition<any>>;

export type ViewDefinition<TParams extends object = Record<never, never>> = {
  WrapView?: ComponentType<{ children: ReactNode } & TParams>;
  TitlebarSlot?: ComponentType;
  MainPanel: ComponentType;
  /**
   * Factory called by Workspace whenever this view becomes active.
   * The returned CommandProvider is registered in commandRegistry and
   * unregistered when the view changes or the params change.
   */
  commandProvider?: (params: TParams) => CommandProvider;
  /**
   * Called before navigation to this view is committed. Return { ok: false }
   * to redirect to a different view instead.
   *
   * Receives `unknown` because params can come from persisted snapshots written
   * by older builds, so each guard must validate the shape before using it.
   */
  canActivate?: (params: unknown) => GuardResult;
};

type Views = typeof views;

export type ViewId = keyof Views;

export type WrapParams<TId extends ViewId> = Views[TId] extends {
  WrapView: ComponentType<infer P>;
}
  ? Omit<P, 'children'>
  : Record<never, never>;

export type GuardResult =
  | { ok: true }
  | { ok: false; redirect: ViewId; params?: Record<string, unknown> };

export function setupNavigationGuards(): void {
  for (const [viewId, view] of Object.entries(views) as Array<
    [ViewId, ViewDefinition<Record<string, unknown>>]
  >) {
    appState.navigation.registerView(viewId);
    if (view.canActivate) {
      appState.navigation.registerGuard(viewId, view.canActivate);
    }
  }
}
