import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { ChosenRoomTile, RoomPickerRow } from '@renderer/lib/components/room-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';

type Props = BaseModalProps<void> & {
  workspaceId: string;
  switchAgentId: string;
  agentName: string;
};

/** A room the agent can be put in: one in its own workspace it is not already in. */
type Candidate = { id: string; name: string; bridgeType: string | null };

/**
 * Puts one agent into rooms — the agent's side of `AddAgentsToRoomModal`, which
 * puts agents into one room.
 *
 * Both write the same membership through `addRoomAgents`; which one you reach
 * for is only a matter of what you were looking at. An agent can only join rooms
 * in the workspace it is registered in, so the choice is scoped to that
 * workspace.
 */
export const AddAgentToRoomsModal = observer(function AddAgentToRoomsModal({
  workspaceId,
  switchAgentId,
  agentName,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();

  const [selected, setSelected] = useState<Candidate[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Membership comes from the same cache the sidebar draws the room tree from,
  // so the rooms offered here and the rooms the agent is shown under cannot
  // disagree. Undefined means it was never fetched — offering every room then
  // would invite a join that is already in place, so say so instead.
  const memberships = switchRoomsStore.roomsFor(workspaceId, switchAgentId);
  const membershipUnknown = memberships === undefined;
  const alreadyIn = new Set((memberships ?? []).map((m) => m.roomId));

  // Every room the server let us see, not only the ones this user created: an
  // agent's usefulness is mostly in rooms someone else set up, and a picker that
  // omitted them made those rooms unreachable from here entirely.
  const candidates: Candidate[] = switchRoomsStore
    .readableRoomsInWorkspace(workspaceId)
    .filter((room) => !alreadyIn.has(room.id) && !selected.some((s) => s.id === room.id))
    .map((room) => ({ id: room.id, name: room.name, bridgeType: room.bridgeType }));
  const nothingToAdd = candidates.length === 0 && selected.length === 0;

  const handleSubmit = useCallback(async () => {
    if (selected.length === 0) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);
    try {
      for (const room of selected) {
        await rpc.workspaces.addRoomAgents({
          workspaceId,
          roomId: room.id,
          agentIds: [switchAgentId],
          direction: 'room_to_agents',
        });
      }
      await switchRoomsStore.refreshRoomState();
      onSuccess();
    } catch (cause) {
      setError(failureText(cause, 'Could not add the agent to the selected rooms.'));
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }, [workspaceId, switchAgentId, selected, onSuccess, setCloseGuard]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Add {agentName} to rooms</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-4">
          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel>Rooms</FieldLabel>
              {selected.length > 0 && (
                <span className="text-sm text-foreground-muted">{selected.length} selected</span>
              )}
            </div>

            {selected.length > 0 && (
              <div className="grid grid-cols-3 gap-2.5">
                {selected.map((room) => (
                  <ChosenRoomTile
                    key={room.id}
                    room={room}
                    onRemove={() =>
                      setSelected((current) => current.filter((r) => r.id !== room.id))
                    }
                  />
                ))}
              </div>
            )}

            <PickerCombobox
              items={candidates}
              onPick={(next) => {
                setSelected((current) => [...current, next]);
                setError(null);
              }}
              searchText={(item) => item.name}
              renderItem={(item) => <RoomPickerRow room={item} />}
              disabled={nothingToAdd}
              placeholder="Search rooms to add..."
              emptyText="No rooms found"
            />
            {membershipUnknown && (
              <p className="mt-1 text-xs text-foreground-warning">
                Which rooms {agentName} is already in could not be read, so every room in the
                workspace is listed. Adding it to one it already belongs to changes nothing.
              </p>
            )}
            {nothingToAdd && !membershipUnknown && (
              <p className="mt-1 text-xs text-foreground-muted">
                {agentName} is already in every room you can see in this workspace.
              </p>
            )}
          </Field>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <ConfirmButton
          onClick={() => void handleSubmit()}
          disabled={selected.length === 0 || isSubmitting}
        >
          {isSubmitting ? 'Adding…' : 'Add to rooms'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
