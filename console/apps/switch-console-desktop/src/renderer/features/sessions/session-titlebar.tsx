import { Bot, DoorOpen, MessageSquare, Pin } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import {
  getLocationStore,
  locationDisplayName,
} from '@renderer/features/locations/stores/location-selectors';
import { useSessionViewContext } from '@renderer/features/sessions/session-view-context';
import {
  getRegisteredSessionData,
  getSessionStore,
  sessionDisplayName,
} from '@renderer/features/sessions/stores/session-selectors';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { switchRoomsStore as sessionRoomsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import {
  TitlebarBreadcrumb,
  type TitlebarCrumb,
} from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { cn } from '@renderer/utils/utils';

/**
 * Where the session sits: the agent running it, the room it is talking in, and
 * the session itself — plus a pin toggle.
 *
 * The room step is dropped rather than faked when the session is in none, or
 * when its room's name has not been read yet. A trail is a claim about where
 * you are, so a step it cannot fill is a step it must not draw.
 */
export const SessionTitlebar = observer(function SessionTitlebar() {
  const { locationId, sessionId } = useSessionViewContext();
  const sessionStore = getSessionStore(locationId, sessionId);
  const sessionPayload = getRegisteredSessionData(locationId, sessionId);
  const { navigate } = useNavigate();

  useEffect(() => {
    sessionRoomsStore.ensureLoaded();
  }, []);

  const agentName = sessionPayload?.agentName;
  const agent = agentsStore.agentAtLocation(locationId, agentName);
  const providerId = agent?.providerId ?? sessionStore?.agentProviderId ?? null;

  const roomId = sessionRoomsStore.roomForSession(sessionId);
  const roomName = roomId ? switchRoomsStore.roomNameById(roomId) : null;
  const bridgeType = roomId ? switchRoomsStore.roomBridgeTypeById(roomId) : null;

  const crumbs: TitlebarCrumb[] = [
    {
      key: 'agent',
      icon: providerId ? (
        <AgentIcon id={providerId} size={14} className="shrink-0" />
      ) : (
        <Bot className="size-3.5 shrink-0" />
      ),
      label: agentName ?? locationDisplayName(getLocationStore(locationId)) ?? 'Agent',
      maxWidthClassName: 'max-w-40',
      onClick: () => navigate('location', { locationId, agentName }),
    },
  ];

  if (roomId && roomName) {
    crumbs.push({
      key: 'room',
      icon: hasBridgeIcon(bridgeType) ? (
        <BridgeIcon bridgeType={bridgeType} size={14} className="shrink-0" />
      ) : (
        <DoorOpen className="size-3.5 shrink-0" />
      ),
      label: roomName,
      maxWidthClassName: 'max-w-40',
      onClick: () => void openRoom(roomId),
    });
  }

  crumbs.push({
    key: 'session',
    icon: <MessageSquare className="size-3.5 shrink-0" />,
    label: sessionDisplayName(sessionStore) ?? 'Session',
  });

  return (
    <Titlebar
      leftSlot={
        <div className="flex min-w-0 items-center">
          <TitlebarBreadcrumb crumbs={crumbs} />
          {sessionStore && sessionPayload && (
            <button
              type="button"
              className="ml-1 text-foreground-muted"
              onClick={() => sessionStore.setPinned(!sessionPayload.isPinned)}
              aria-label={sessionPayload.isPinned ? 'Unpin session' : 'Pin session'}
            >
              <Pin
                className={cn('size-3.5', sessionPayload.isPinned && 'text-foreground-muted')}
                fill={sessionPayload.isPinned ? 'currentColor' : 'none'}
              />
            </button>
          )}
        </div>
      }
    />
  );
});
