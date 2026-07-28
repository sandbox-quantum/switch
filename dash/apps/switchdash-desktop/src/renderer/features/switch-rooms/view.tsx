import { observer } from 'mobx-react-lite';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { RoomMainPanel } from './room-main-panel';

const RoomTitlebar = observer(function RoomTitlebar() {
  const { params } = useParams('room');
  const name = switchRoomsStore.roomNameById(params.roomId);
  const serverName = switchRoomsStore.roomServerName(params.roomId);

  return (
    <Titlebar
      leftSlot={
        <div className="flex items-center gap-1 px-2 text-sm text-foreground-muted">
          {serverName && (
            <>
              <span className="max-w-40 truncate text-sm text-foreground-passive">
                {serverName}
              </span>
              <span className="text-sm text-foreground-passive">/</span>
            </>
          )}
          <span className="max-w-56 truncate">{name ?? 'Room'}</span>
        </div>
      }
    />
  );
});

export const roomView = {
  WrapView: ({ children }: { children: React.ReactNode; roomId: string }) => <>{children}</>,
  TitlebarSlot: RoomTitlebar,
  MainPanel: RoomMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const roomId =
      typeof params === 'object' && params !== null
        ? (params as { roomId?: unknown }).roomId
        : undefined;
    if (typeof roomId !== 'string') {
      return { ok: false, redirect: 'home' };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ roomId: string }>;
