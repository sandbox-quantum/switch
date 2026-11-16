import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { SwitchConsoleAppIcon } from '@renderer/lib/switch-console-app-icon';
import { Button } from '@renderer/lib/ui/button';
import { homeServerId } from './home-target';
import { HomeFooter } from './home/home-footer';
import { switchServersStore } from './switch-servers-store';

/**
 * What the app shows with no Switch server added. A fresh install opens the
 * first-run pages instead, so this is reached by removing the last server
 * while agents are still kept, or from a build without the first run.
 *
 * Once a server exists, its Home is the home: the guard sends there, and so
 * does this page the moment one is added.
 */
const NoServerPanel = observer(function NoServerPanel() {
  const showAddServerModal = useShowModal('addServerModal');

  useEffect(
    () =>
      reaction(
        () => homeServerId(),
        (serverId) => {
          if (serverId !== null) appState.navigation.revalidate();
        }
      ),
    []
  );

  return (
    // No TitlebarSlot, so the empty surface is the window's drag region; the
    // controls below opt out.
    <div className="flex h-full flex-col overflow-y-auto bg-background text-foreground [-webkit-app-region:drag]">
      {/* Until the list is read, "no server" is not known yet. */}
      {switchServersStore.loaded && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
          <SwitchConsoleAppIcon size={64} className="rounded-2xl" />
          <p className="text-center text-base text-foreground-muted">
            Add a Switch server to get started.
          </p>
          <Button className="[-webkit-app-region:no-drag]" onClick={() => showAddServerModal({})}>
            Add a server
          </Button>
        </div>
      )}
      <div className="mt-auto [-webkit-app-region:no-drag]">
        <HomeFooter />
      </div>
    </div>
  );
});

export const noServerView = {
  MainPanel: NoServerPanel,
  canActivate: (): GuardResult => {
    const serverId = homeServerId();
    return serverId === null
      ? { ok: true }
      : { ok: false, redirect: 'server', params: { serverId } };
  },
} satisfies ViewDefinition;
