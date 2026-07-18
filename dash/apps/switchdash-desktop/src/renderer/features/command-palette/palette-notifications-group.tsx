import { Command } from 'cmdk';
import { useObserver } from 'mobx-react-lite';
import {
  asMounted,
  getLocationManagerStore,
} from '@renderer/features/locations/stores/location-selectors';
import { sessionAgentRegistry } from '@renderer/features/sessions/stores/session-agent-registry';
import { isRegistered, type SessionStore } from '@renderer/features/sessions/stores/session-store';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { cn } from '@renderer/utils/utils';
import { PaletteSessionItem } from './palette-session-item';

type NotificationItem = { locationId: string; sessionStore: SessionStore };

const GROUP_CLASS = cn(
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
  '[&_[cmdk-group-heading]]:text-foreground/50'
);

interface PaletteNotificationsGroupProps {
  currentLocationId: string | undefined;
  currentSessionId: string | undefined;
  onClose: () => void;
  navigate: NavigateFnTyped;
}

export function PaletteNotificationsGroup({
  currentLocationId,
  currentSessionId,
  onClose,
  navigate,
}: PaletteNotificationsGroupProps) {
  const items = useObserver((): NotificationItem[] => {
    const result: NotificationItem[] = [];

    for (const projectStore of getLocationManagerStore().locations.values()) {
      const mounted = asMounted(projectStore);
      if (!mounted) continue;
      const pid = mounted.data.id;

      for (const [tid, sessionStore] of mounted.sessionManager.sessions) {
        if (!isRegistered(sessionStore)) continue;
        const agent = sessionAgentRegistry.get(tid);
        if (!agent) continue;

        const status = agent.sessionStatus;
        // Only surface awaiting-input, error, completed — not working or idle.
        if (!status || status === 'idle' || status === 'working') continue;

        result.push({ locationId: pid, sessionStore });
      }
    }

    return result;
  });

  if (items.length === 0) return null;

  return (
    <Command.Group heading="Notifications" className={GROUP_CLASS}>
      {items.map((item) => (
        <PaletteSessionItem
          key={item.sessionStore.data.id}
          sessionStore={item.sessionStore}
          value={`notif:session:${item.sessionStore.data.id}`}
          onSelect={() => {
            if (
              item.locationId !== currentLocationId ||
              item.sessionStore.data.id !== currentSessionId
            ) {
              navigate('session', {
                locationId: item.locationId,
                sessionId: item.sessionStore.data.id,
              });
            }
            onClose();
          }}
        />
      ))}
    </Command.Group>
  );
}
