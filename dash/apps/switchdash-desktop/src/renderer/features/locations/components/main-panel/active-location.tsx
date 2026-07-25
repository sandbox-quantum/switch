import { observer } from 'mobx-react-lite';
import { SessionList } from '@renderer/features/locations/components/session-view/session-list';
import { SettingsPanel } from '@renderer/features/locations/components/settings-view/settings-panel';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import type { LocationView } from '@renderer/features/locations/stores/location-view';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { cn } from '@renderer/utils/utils';

function LocationViewNav({
  items,
  activeView,
  onChange,
}: {
  items: Array<{ id: LocationView; label: string }>;
  activeView: LocationView;
  onChange: (view: LocationView) => void;
}) {
  return (
    <div className="py-10">
      <nav className="flex min-h-0 w-52 flex-col gap-0.5 overflow-y-auto" aria-label="Location">
        {items.map((item) => {
          const isActive = item.id === activeView;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-normal text-foreground-muted transition-colors hover:bg-background-1 hover:text-foreground',
                isActive &&
                  'bg-background-2 text-foreground hover:bg-background-2 hover:text-foreground'
              )}
            >
              <span className="truncate text-left">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export const ActiveLocation = observer(function ActiveLocation() {
  const {
    params: { locationId },
  } = useParams('location');
  const store = asMounted(getLocationStore(locationId));

  if (!store) return null;

  const items: Array<{ id: LocationView; label: string }> = [
    { id: 'sessions', label: 'Sessions' },
    { id: 'settings', label: 'Settings' },
  ];

  // 'subagents' is a retired view; fall back to Sessions if a stale view sticks.
  const activeView = store.view.activeView === 'settings' ? 'settings' : 'sessions';

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1060px] flex-col gap-6 px-8">
        <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)] gap-8 overflow-hidden">
          <LocationViewNav
            items={items}
            activeView={activeView}
            onChange={(view) => store.view.setLocationView(view)}
          />
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
            <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-1 py-10">
              {activeView === 'sessions' && <SessionList />}
              {activeView === 'settings' && <SettingsPanel />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
