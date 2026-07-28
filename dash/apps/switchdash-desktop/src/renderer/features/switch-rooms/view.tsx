import { observer } from 'mobx-react-lite';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { RoomMainPanel } from './room-main-panel';

const RoomTitlebar = observer(function RoomTitlebar() {
  const { params } = useParams('room');
  const name = switchRoomsStore.roomNameById(params.roomId);
  return <span className="truncate text-sm font-medium">{name ?? 'Room'}</span>;
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
