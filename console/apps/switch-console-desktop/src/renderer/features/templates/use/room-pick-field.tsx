import { TileGrid } from '@renderer/features/room-templates/entity-fields';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { ChosenRoomTile, type RoomPick, RoomPickerRow } from '@renderer/lib/components/room-picker';

/** Pick one room of the workspace by id, or none. */
export function RoomPickField({
  rooms,
  loading,
  value,
  onChange,
}: {
  rooms: RoomPick[];
  loading: boolean;
  value: string | null;
  onChange: (roomId: string | null) => void;
}) {
  const chosen = value ? rooms.find((r) => r.id === value) : undefined;
  if (chosen) {
    return (
      <TileGrid>
        <ChosenRoomTile room={chosen} onRemove={() => onChange(null)} />
      </TileGrid>
    );
  }
  return (
    <PickerCombobox
      items={rooms}
      onPick={(room) => onChange(room.id)}
      searchText={(room) => room.name}
      renderItem={(room) => <RoomPickerRow room={room} />}
      disabled={loading}
      placeholder={loading ? 'Loading rooms…' : 'Search rooms…'}
      emptyText="No rooms found"
    />
  );
}
