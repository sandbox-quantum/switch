import { useQuery } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
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
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

type Props = BaseModalProps<void> & { roomId: string };

export const AddAgentsToRoomModal = observer(function AddAgentsToRoomModal({
  roomId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();
  const serverId = switchRoomsStore.roomServerId(roomId);
  const roomName = switchRoomsStore.roomNameById(roomId);

  const [selected, setSelected] = useState<RemoteAgentSummary[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ['remote-agents', serverId],
    queryFn: () => rpc.switchServers.listRemoteAgents(serverId!),
    enabled: !!serverId,
  });
  const membersQuery = useQuery({
    queryKey: ['roomAgentIds', serverId, roomId],
    queryFn: () => rpc.switchServers.listRoomAgentIds({ serverId: serverId!, roomId }),
    enabled: !!serverId,
  });

  // Agents already in the room are dropped rather than shown as no-ops: the
  // server ignores them, so offering them would suggest an effect there isn't.
  const members = new Set(membersQuery.data ?? []);
  const candidates = (agentsQuery.data ?? []).filter(
    (a) => !members.has(a.id) && !selected.some((s) => s.id === a.id)
  );
  const loading = agentsQuery.isLoading || membersQuery.isLoading;
  const nothingToAdd = !loading && candidates.length === 0 && selected.length === 0;

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
      // The sidebar lists agents under a room by membership, so the caches that
      // answer "which rooms is this agent in" have to be re-read, not just the
      // room list.
      await switchRoomsStore.refreshAll();
      await switchRoomsStore.loadRoomNames();
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
              onValueChange={(next: RemoteAgentSummary | null) => {
                if (next) setSelected((current) => [...current, next]);
                setError(null);
              }}
              isItemEqualToValue={(a: RemoteAgentSummary, b: RemoteAgentSummary) => a.id === b.id}
              filter={(item: RemoteAgentSummary, query) =>
                item.name.toLowerCase().includes(query.toLowerCase())
              }
              autoHighlight
            >
              <ComboboxTrigger
                disabled={loading || nothingToAdd}
                className={cn(
                  'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none',
                  (loading || nothingToAdd) && 'cursor-not-allowed opacity-60'
                )}
              >
                <span className="flex-1 truncate text-left text-foreground-muted">
                  {loading ? 'Loading agents…' : 'Add an agent'}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
              </ComboboxTrigger>
              <ComboboxContent className="min-w-(--anchor-width)">
                <ComboboxInput showTrigger={false} placeholder="Search agents…" />
                <ComboboxList>
                  {(item: RemoteAgentSummary) => (
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
                Every agent on this server is already in the room.
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
