import { TileGrid } from '@renderer/features/room-templates/entity-fields';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { ChosenRoomTile, type RoomPick, RoomPickerRow } from '@renderer/lib/components/room-picker';
import { NEW } from '@shared/core/switch-servers/room-template-params';

/**
 * The room an agent works in, for a `room` param: one of the workspace's
 * rooms by name, or `$new` for the room the template creates, offered when
 * the template describes one.
 */
export function RoomChoiceField({
  rooms,
  loading,
  newRoom,
  value,
  onChange,
}: {
  rooms: RoomPick[];
  loading: boolean;
  /** The template's own room, resolved as far as the inputs allow, or null when it has none. */
  newRoom: { name: string; bridgeType: string | null } | null;
  /** A room name, `$new`, or empty. */
  value: string;
  onChange: (value: string) => void;
}) {
  const newPick: RoomPick | null = newRoom
    ? { id: NEW, name: newRoom.name, bridgeType: newRoom.bridgeType }
    : null;
  if (value === NEW && newPick) {
    return (
      <TileGrid>
        <ChosenRoomTile room={newPick} subtitle="New room" onRemove={() => onChange('')} />
      </TileGrid>
    );
  }
  if (value !== '') {
    const found = rooms.find((r) => r.name === value);
    return (
      <TileGrid>
        <ChosenRoomTile
          room={found ?? { id: value, name: value, bridgeType: null }}
          subtitle={found ? undefined : 'Not on this server'}
          subtitleTone={found ? undefined : 'warning'}
          onRemove={() => onChange('')}
        />
      </TileGrid>
    );
  }
  const items = newPick ? [newPick, ...rooms] : rooms;
  return (
    <PickerCombobox
      items={items}
      onPick={(room) => onChange(room.id === NEW ? NEW : room.name)}
      searchText={(room) => room.name}
      renderItem={(room) =>
        room.id === NEW ? (
          <>
            <span className="min-w-0 flex-1 truncate">{room.name}</span>
            <span className="shrink-0 text-xs text-foreground-muted">New room</span>
          </>
        ) : (
          <RoomPickerRow room={room} />
        )
      }
      disabled={loading}
      placeholder={loading ? 'Loading rooms…' : 'Search rooms…'}
      emptyText="No rooms found"
    />
  );
}
