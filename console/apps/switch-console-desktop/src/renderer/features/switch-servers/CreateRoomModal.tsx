import { useQuery } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
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
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { RemoteAgentSummary, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';

type CreateRoomModalArgs = {
  /** Create on this server instead of the active one — for callers that are not
   * driven by the sidebar's server scope, such as onboarding. */
  serverId?: string;
};

type Props = BaseModalProps<{ roomId: string }> & CreateRoomModalArgs;

export const CreateRoomModal = observer(function CreateRoomModal({
  serverId: overrideServerId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();

  // The sidebar shows one server at a time, so the room belongs to that server;
  // asking again would let the user create a room somewhere they are not
  // looking, and then wonder where it went.
  const serverId = overrideServerId ?? switchServersStore.activeServerId ?? '';
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [bridgeId, setBridgeId] = useState<string | null>(null);
  const [agents, setAgents] = useState<RemoteAgentSummary[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
    enabled: !!serverId,
  });
  const agentsQuery = useQuery({
    queryKey: ['remote-agents', serverId],
    queryFn: () => rpc.switchServers.listRemoteAgents(serverId),
    enabled: !!serverId,
  });

  // Only a running bridge can back a new room, and creating a room here means
  // creating a channel on it — a bridge withheld from that (an operator's
  // switch, or a platform like Telegram that has no such call at all) is just
  // as unusable for this form. Keeping both kinds out of the picker (rather
  // than letting the create call fail) means the one thing shown is the one
  // thing that works — and each reason for an empty list is stated outright,
  // rather than collapsed into one generic "no bridges".
  const allBridges = bridgesQuery.data ?? [];
  const activeBridges = allBridges.filter((b) => b.status === 'active');
  const bridges = activeBridges.filter((b) => b.canCreateChannels);
  const selectedBridge =
    bridges.find((b) => b.id === bridgeId) ??
    bridges.find((b) => b.isDefault) ??
    bridges[0] ??
    null;
  const loaded = !bridgesQuery.isLoading;
  const noBridgesAtAll = loaded && allBridges.length === 0;
  const noneRunning = loaded && allBridges.length > 0 && activeBridges.length === 0;
  const noneCanCreateChannels = loaded && activeBridges.length > 0 && bridges.length === 0;
  const noUsableBridge = noBridgesAtAll || noneRunning || noneCanCreateChannels;

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const canSubmit =
    !!serverId && !!trimmedName && !!trimmedDescription && !!selectedBridge && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedBridge) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);

    try {
      const result = await rpc.switchServers.createRoom({
        serverId,
        name: trimmedName,
        description: trimmedDescription,
        instructions: instructions.trim() || undefined,
        bridgeId: selectedBridge.id,
        agentIds: agents.map((a) => a.id),
      });

      if (result.kind !== 'created') {
        setError(messageFor(result));
        return;
      }

      // Re-read the room state so the sidebar shows the room straight away
      // rather than at the next window focus.
      await switchRoomsStore.refreshRoomState();
      onSuccess({ roomId: result.room.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }, [
    canSubmit,
    selectedBridge,
    serverId,
    trimmedName,
    trimmedDescription,
    instructions,
    agents,
    onSuccess,
    setCloseGuard,
  ]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>New room{server ? ` on ${server.name}` : ''}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-5">
          {!server && (
            <p className="text-destructive text-xs">
              No Switch server is selected, so there is nowhere to create a room. Choose a server in
              the sidebar first.
            </p>
          )}

          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              autoFocus
              placeholder="e.g. design-review"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void handleSubmit();
              }}
            />
          </Field>

          <Field>
            <FieldLabel>Description</FieldLabel>
            <Input
              placeholder="What this room is for"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void handleSubmit();
              }}
            />
          </Field>

          <Field>
            <FieldLabel>Messaging app</FieldLabel>
            <Select
              value={selectedBridge?.id ?? ''}
              onValueChange={(next) => setBridgeId(next ?? null)}
              disabled={bridgesQuery.isLoading || noUsableBridge}
            >
              <SelectTrigger>
                {/* Resolve the label ourselves: the trigger shows the raw value
                    otherwise, which for a bridge is an opaque uuid. */}
                <SelectValue
                  placeholder={bridgesQuery.isLoading ? 'Loading…' : 'No messaging app available'}
                >
                  {selectedBridge ? bridgeLabel(selectedBridge) : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {bridges.map((bridge) => (
                  <SelectItem key={bridge.id} value={bridge.id}>
                    {bridgeLabel(bridge)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {noBridgesAtAll && (
              <p className="text-destructive mt-1 text-xs">
                This server has no messaging app connected, so a room created here would be
                unreachable. Connect one first.
              </p>
            )}
            {noneRunning && (
              <p className="text-destructive mt-1 text-xs">
                This server's messaging apps are not running, so a room created here would be
                unreachable. Start one, or connect another.
              </p>
            )}
            {noneCanCreateChannels && (
              <p className="text-destructive mt-1 text-xs">
                None of the running messaging apps can create a channel from Switch — for example, a
                Telegram bot can't create chats on its own. Make the chat directly in the messaging
                app instead (for Telegram, create the group and add the bot to it) and it becomes a
                room here once it exists.
              </p>
            )}
            {bridgesQuery.isError && (
              <p className="text-destructive mt-1 text-xs">
                Could not load messaging apps: {errorText(bridgesQuery.error)}
              </p>
            )}
          </Field>

          <Field>
            <FieldLabel>Agents</FieldLabel>
            <Combobox
              items={(agentsQuery.data ?? []).filter((a) => !agents.some((s) => s.id === a.id))}
              value={null}
              onValueChange={(next: RemoteAgentSummary | null) => {
                if (next) setAgents((current) => [...current, next]);
              }}
              isItemEqualToValue={(a: RemoteAgentSummary, b: RemoteAgentSummary) => a.id === b.id}
              filter={(item: RemoteAgentSummary, query) =>
                item.name.toLowerCase().includes(query.toLowerCase())
              }
              autoHighlight
            >
              <ComboboxTrigger
                disabled={agentsQuery.isLoading}
                className={cn(
                  'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none',
                  agentsQuery.isLoading && 'cursor-not-allowed opacity-60'
                )}
              >
                <span className="flex-1 truncate text-left text-foreground-muted">
                  {agentsQuery.isLoading ? 'Loading agents…' : 'Add an agent'}
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
            {agents.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {agents.map((agent) => (
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
                        setAgents((current) => current.filter((a) => a.id !== agent.id))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-foreground-muted">
              Optional — agents can be added to the room later.
            </p>
          </Field>

          <Field>
            <FieldLabel>Instructions</FieldLabel>
            <Textarea
              placeholder="Optional guidance shown to agents when they connect"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
            />
          </Field>

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {isSubmitting ? 'Creating…' : 'Create room'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

function bridgeLabel(bridge: RemoteBridge): string {
  return bridge.isDefault ? `${bridge.displayName} (default)` : bridge.displayName;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Turn a failed create into something the user can act on. */
function messageFor(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'bridge-unavailable':
      return `The messaging app is not available: ${result.message ?? 'unknown reason'}`;
    default:
      return result.message ?? 'Could not create the room.';
  }
}
