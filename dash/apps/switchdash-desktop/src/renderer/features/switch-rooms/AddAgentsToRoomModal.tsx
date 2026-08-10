import { ChevronDown, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
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
  ComboboxTrigger,
} from '@renderer/lib/ui/combobox';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';

type Props = BaseModalProps<void> & { roomId: string };

/** An agent that can be added: this install's agent, by its Switch identity. */
type Candidate = { id: string; name: string };

export const AddAgentsToRoomModal = observer(function AddAgentsToRoomModal({
  roomId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();
  const serverId = switchRoomsStore.roomServerId(roomId);
  const roomName = switchRoomsStore.roomNameById(roomId);

  const [selected, setSelected] = useState<Candidate[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Who can be added is answered from the same state the sidebar draws the room
  // from, not from a query of its own: the room's members and the agents on
  // offer have to be the same two sets the tree uses, or the picker and the
  // sidebar can disagree about who is already in the room.
  const members = new Set(switchRoomsStore.localMemberIds(roomId));
  // Only this install's agents are offered. An agent registered on another
  // switchdash could be added server-side but could never be shown or driven
  // from here, so it is not ours to offer.
  const candidates: Candidate[] = serverId
    ? agentsStore
        .agentsOnServer(serverId)
        .map((agent) => ({ id: agent.switchAgentId as string, name: agent.name }))
        .filter((a) => !members.has(a.id) && !selected.some((s) => s.id === a.id))
    : [];
  const nothingToAdd = candidates.length === 0 && selected.length === 0;

  const handleSubmit = useCallback(async () => {
    if (!serverId || selected.length === 0) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);
    try {
      await rpc.switchServers.addRoomAgents({
        serverId,
        roomId,
        agentIds: selected.map((a) => a.id),
      });
      await switchRoomsStore.refreshRoomState();
      onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }, [serverId, roomId, selected, onSuccess, setCloseGuard]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Add agents to {roomName ?? 'room'}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-4">
          {!serverId && (
            <p className="text-destructive text-xs">
              This room&apos;s server is not known yet, so its members cannot be changed.
            </p>
          )}

          <Field>
            <FieldLabel>Agents</FieldLabel>
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
              <ComboboxTrigger
                disabled={nothingToAdd}
                className={cn(
                  'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none',
                  nothingToAdd && 'cursor-not-allowed opacity-60'
                )}
              >
                <span className="flex-1 truncate text-left text-foreground-muted">
                  Add an agent
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
              </ComboboxTrigger>
              <ComboboxContent className="min-w-(--anchor-width)">
                <ComboboxInput showTrigger={false} placeholder="Search agents…" />
                <ComboboxList>
                  {(item: Candidate) => (
                    <ComboboxItem key={item.id} value={item}>
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
                <ComboboxEmpty>No agents found</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
            {selected.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selected.map((agent) => (
                  <span
                    key={agent.id}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs"
                  >
                    {agent.name}
                    <button
                      type="button"
                      aria-label={`Remove ${agent.name}`}
                      className="text-foreground-muted hover:text-foreground"
                      onClick={() =>
                        setSelected((current) => current.filter((a) => a.id !== agent.id))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {nothingToAdd && (
              <p className="mt-1 text-xs text-foreground-muted">
                Every agent on this switchdash is already in the room. Agents registered elsewhere
                can only be added from the gateway.
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
          disabled={!serverId || selected.length === 0 || isSubmitting}
        >
          {isSubmitting ? 'Adding…' : 'Add to room'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
