import { Hash, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/lib/ui/combobox';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';

type Props = BaseModalProps<void> & {
  serverId: string;
  switchAgentId: string;
  agentName: string;
};

/** A room the agent can be put in: one on its own server it is not already in. */
type Candidate = { id: string; name: string; bridgeType: string | null };

/** Where a room's conversation actually happens, for the right of its row. */
function whereLabel(bridgeType: string | null): string {
  return bridgeType ? bridgePlatformLabel(bridgeType) : 'Switch only';
}

/** The mark of the app a room is bridged to, or a plain channel mark when it
 * lives on Switch alone. */
function RoomMark({ bridgeType, size }: { bridgeType: string | null; size: number }) {
  if (!hasBridgeIcon(bridgeType)) {
    return <Hash className="size-4 shrink-0 text-foreground-muted" />;
  }
  return <BridgeIcon bridgeType={bridgeType} size={size} />;
}

/**
 * Puts one agent into rooms — the agent's side of `AddAgentsToRoomModal`, which
 * puts agents into one room.
 *
 * Both write the same membership through `addRoomAgents`; which one you reach
 * for is only a matter of what you were looking at. An agent can only join rooms
 * on the server it is registered with, so the choice is scoped to that server.
 */
export const AddAgentToRoomsModal = observer(function AddAgentToRoomsModal({
  serverId,
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
  const memberships = switchRoomsStore.roomsFor(serverId, switchAgentId);
  const membershipUnknown = memberships === undefined;
  const alreadyIn = new Set((memberships ?? []).map((m) => m.roomId));

  // Every room the server let us see, not only the ones this user created: an
  // agent's usefulness is mostly in rooms someone else set up, and a picker that
  // omitted them made those rooms unreachable from here entirely.
  const candidates: Candidate[] = switchRoomsStore
    .readableRoomsOnServer(serverId)
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
        await rpc.switchServers.addRoomAgents({
          serverId,
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
  }, [serverId, switchAgentId, selected, onSuccess, setCloseGuard]);

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

            <Combobox
              items={candidates}
              value={null}
              onValueChange={(next: Candidate | null) => {
                if (next) setSelected((current) => [...current, next]);
                setError(null);
              }}
              isItemEqualToValue={(a: Candidate, b: Candidate) => a.id === b.id}
              filter={(item: Candidate, query) =>
                item.name.toLowerCase().includes(query.toLowerCase())
              }
              autoHighlight
            >
              {/* The search box is the control rather than something a button
                  has to open: putting an agent in several rooms at once is the
                  reason this dialog exists. */}
              <ComboboxInput
                showTrigger={false}
                disabled={nothingToAdd}
                placeholder="Search rooms to add..."
                leftAddon={<Search className="size-3.5 text-foreground-muted" />}
              />
              <ComboboxContent className="min-w-(--anchor-width)">
                <ComboboxList>
                  {(item: Candidate) => (
                    <ComboboxItem key={item.id} value={item} showCheck={false}>
                      <RoomMark bridgeType={item.bridgeType} size={16} />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="shrink-0 text-xs text-foreground-muted">
                        {whereLabel(item.bridgeType)}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
                <ComboboxEmpty>No rooms found</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
            {membershipUnknown && (
              <p className="mt-1 text-xs text-foreground-warning">
                Which rooms {agentName} is already in could not be read, so every room on the server
                is listed. Adding it to one it already belongs to changes nothing.
              </p>
            )}
            {nothingToAdd && !membershipUnknown && (
              <p className="mt-1 text-xs text-foreground-muted">
                {agentName} is already in every room you can see on this server.
              </p>
            )}
          </Field>

          {error && <p className="text-destructive text-xs">{error}</p>}
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

/** A room already chosen, with the way to take it back out. */
function ChosenRoomTile({ room, onRemove }: { room: Candidate; onRemove: () => void }) {
  return (
    // `--fill` rather than `--surface-2`: in dark mode that surface is the
    // dialog's own background, so a tile drawn in it was a tile nobody could
    // see.
    <div className="group relative flex flex-col gap-2 rounded-[10px] bg-[var(--fill)] p-3">
      <RoomMark bridgeType={room.bridgeType} size={22} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{room.name}</span>
        <span className="truncate text-xs text-foreground-muted">
          {whereLabel(room.bridgeType)}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Remove ${room.name}`}
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--fill-2)] hover:text-foreground focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
