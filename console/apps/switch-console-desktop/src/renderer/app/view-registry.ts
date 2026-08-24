import type { ComponentType, ReactNode } from 'react';
import { homeView } from '@renderer/app/home-view';
import { locationView } from '@renderer/features/locations/view';
import { remoteHostView } from '@renderer/features/remote-hosts/views/remote-host-view';
import { remoteHostsView } from '@renderer/features/remote-hosts/views/remote-hosts-view';
import { sessionView } from '@renderer/features/sessions/view';
import { settingsView } from '@renderer/features/settings/settings-view';
import { roomView } from '@renderer/features/switch-rooms/view';
import { serverAgentsView } from '@renderer/features/switch-servers/server-agents-view';
import { serverRoomsView } from '@renderer/features/switch-servers/server-rooms-view';
import { serverView } from '@renderer/features/switch-servers/view';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { appState } from '@renderer/lib/stores/app-state';
import type { ViewIdName } from '@shared/core/views/view-ids';

// Switch Console views: agents-at-a-location (location), sessions (session), home, settings,
// and a connected Switch gateway's workspace — its Home (server) plus that
// server's agents and rooms. Automations, library, skills, and mcp were removed.
export const views = {
  home: homeView,
  location: locationView,
  session: sessionView,
  room: roomView,
  settings: settingsView,
  server: serverView,
  serverAgents: serverAgentsView,
  serverRooms: serverRoomsView,
  remoteHosts: remoteHostsView,
  remoteHost: remoteHostView,
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

/**
 * The registry and the shared list of view ids say the same thing.
 *
 * The list is what the main process reports against, and it cannot import this
 * file. Both directions are asserted, so adding a view without naming it there —
 * or leaving a name behind after removing one — fails to compile instead of
 * quietly reporting a screen that does not exist or missing one that does.
 */
const _viewIdsAreExhaustive: ViewIdName extends ViewId ? true : never = true;
const _viewIdsAreComplete: ViewId extends ViewIdName ? true : never = true;
void _viewIdsAreExhaustive;
void _viewIdsAreComplete;

export type WrapParams<TId extends ViewId> = Views[TId] extends {
  WrapView: ComponentType<infer P>;
}
  ? Omit<P, 'children'>
  : Record<never, never>;

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      redirect: ViewId;
      params?: Record<string, unknown>;
      /**
       * Set when the params themselves are stale — naming something a newer
       * build retired — rather than the destination merely being unavailable
       * right now. Stored params are then dropped, so the fallback in
       * `navigate()` cannot feed them back to the guard on the next attempt and
       * leave the view permanently unreachable.
       *
       * Guards that reject on runtime state must leave this unset: their params
       * are still good, and a rejection while that state loads would discard
       * them.
       */
      discardParams?: boolean;
    };

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
