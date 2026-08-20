import { observer } from 'mobx-react-lite';
import { AgentEditsProvider } from '@renderer/features/locations/components/main-panel/agent-edits';
import { AgentPageHeader } from '@renderer/features/locations/components/main-panel/agent-page-header';
import { AgentSaveBar } from '@renderer/features/locations/components/main-panel/agent-save-bar';
import { SessionList } from '@renderer/features/locations/components/session-view/session-list';
import { SettingsPanel } from '@renderer/features/locations/components/settings-view/settings-panel';
import { SidecarPanel } from '@renderer/features/locations/components/settings-view/sidecar-panel';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import { useParams } from '@renderer/lib/layout/navigation-provider';

/**
 * An agent, on one page: who it is, how it behaves, the process keeping it
 * connected, and its sessions — read top to bottom.
 *
 * It used to be three tabs down a side nav, which asked the reader to know
 * which of them held what before they could look at anything. The page is short
 * enough to scroll instead.
 */
export const ActiveLocation = observer(function ActiveLocation() {
  const {
    params: { locationId },
  } = useParams('location');
  const store = asMounted(getLocationStore(locationId));

  if (!store) return null;

  // The sidecar is a remote-only concern — a local agent runs no on-host process.
  const isRemote = store.data.sshHost !== null;

  return (
    <AgentEditsProvider>
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-10 px-8 pb-20">
            <AgentPageHeader />
            <SettingsPanel />
            {isRemote && <SidecarPanel />}
            <SessionList />
          </div>
        </div>
        {/* Outside the scroll area: an edit made at the top of the page should
            not need scrolling to the bottom before it can be saved. */}
        <AgentSaveBar />
      </div>
    </AgentEditsProvider>
  );
});
