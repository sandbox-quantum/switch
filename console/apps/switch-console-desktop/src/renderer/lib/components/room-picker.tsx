import { Hash } from 'lucide-react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { ChosenTile } from '@renderer/lib/components/chosen-tile';

/** The least a room row or tile needs to draw itself. */
export type RoomPick = {
  id: string;
  name: string;
  bridgeType: string | null;
};

/** Where a room's conversation actually happens, for the right of its row. */
export function roomWhereLabel(bridgeType: string | null): string {
  return bridgeType ? bridgePlatformLabel(bridgeType) : 'Switch only';
}

/** The mark of the app a room is bridged to, or a plain channel mark when it
 * lives on Switch alone. */
export function RoomMark({ bridgeType, size }: { bridgeType: string | null; size: number }) {
  if (!hasBridgeIcon(bridgeType)) {
    return <Hash className="size-4 shrink-0 text-foreground-muted" />;
  }
  return <BridgeIcon bridgeType={bridgeType} size={size} />;
}

/** One room in a picker list: its mark, name, and where it lives. */
export function RoomPickerRow({ room }: { room: RoomPick }) {
  return (
    <>
      <RoomMark bridgeType={room.bridgeType} size={16} />
      <span className="min-w-0 flex-1 truncate">{room.name}</span>
      <span className="shrink-0 text-xs text-foreground-muted">
        {roomWhereLabel(room.bridgeType)}
      </span>
    </>
  );
}

/** A room already chosen, with the way to take it back out. */
export function ChosenRoomTile({
  room,
  subtitle,
  subtitleTone,
  onRemove,
}: {
  room: RoomPick;
  /** Defaults to where the room lives. */
  subtitle?: string;
  subtitleTone?: 'muted' | 'warning';
  onRemove: () => void;
}) {
  return (
    <ChosenTile
      mark={<RoomMark bridgeType={room.bridgeType} size={22} />}
      title={room.name}
      subtitle={subtitle ?? roomWhereLabel(room.bridgeType)}
      subtitleTone={subtitleTone}
      onRemove={onRemove}
    />
  );
}
