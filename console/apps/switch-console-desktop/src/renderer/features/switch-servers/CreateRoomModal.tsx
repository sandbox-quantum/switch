import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { openRoomView } from '@renderer/features/sidebar/sidebar-room-grouping';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import {
  AgentPickerRow,
  ChosenAgentTile,
  agentProviderLabelFor,
} from '@renderer/lib/components/agent-picker';
import { BridgeTile, bridgeUnusableReason } from '@renderer/lib/components/bridge-tile';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';
import { useMyIdentities } from './use-my-identities';

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
  const workspaceId = workspacesStore.soleIdOnServer(serverId || null);
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [bridgeId, setBridgeId] = useState<string | null>(null);
  const [agents, setAgents] = useState<RemoteAgentSummary[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const agentsQuery = useQuery({
    queryKey: ['remote-agents', workspaceId],
    queryFn: () => rpc.workspaces.listAgents(workspaceId as string),
    enabled: workspaceId !== null,
  });
  // Which account on each app is the person creating the room. A room on an app
  // they have not claimed an account on works, but their own messages in it are
  // from a stranger as far as the agents are concerned — so it is said here,
  // while the app is being chosen, rather than discovered later.
  const { identities } = useMyIdentities(workspaceId);

  /**
   * Only agents this install registered on the server.
   *
   * The server answers with everyone registered on it, including agents
   * belonging to somebody else's Switch Console. Those cannot be shown under a
   * room here or driven from here, so offering them in the picker promises
   * something this app cannot deliver — the same rule the room views already
   * follow.
   */
  const invitableAgents = (agentsQuery.data ?? []).filter((remote) =>
    workspaceId === null
      ? false
      : agentsStore
          .agentsInWorkspace(workspaceId)
          .some((local) => local.switchAgentId === remote.id)
  );

  // Only a running bridge can back a new room, and creating a room here means
  // creating a channel on it — a bridge withheld from that (an operator's
  // switch, or a platform like Telegram that has no such call at all) is just
  // as unusable for this form. Every connected app is shown, but an unusable
  // one is not selectable and says which of these it is: an app that is simply
  // absent from the grid explains nothing, and the user goes looking for it.
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

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const canSubmit =
    workspaceId !== null &&
    !!trimmedName &&
    !!trimmedDescription &&
    !!selectedBridge &&
    !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedBridge) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);

    try {
      const result = await rpc.workspaces.createRoom({
        workspaceId: workspaceId as string,
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
      // rather than at the next window focus. This goes through the sidebar's
      // own refresh rather than `refreshRoomState`, which only re-reads
      // membership for the agents the sidebar knew about when it last loaded —
      // an agent onboarded moments ago is not among them, so the room would
      // appear with nothing under it until the next reconcile.
      await refreshSidebarRoomState(true);

      // Open what was just created: listed in the sidebar, expanded in the
      // tree, and shown in the main panel. Creating a room and being left where
      // you were reads as if nothing happened — and the agent grouping does not
      // list rooms at all, so the new room would be nowhere on screen.
      sidebarStore.setGrouping('room');
      sidebarStore.ensureRoomExpanded(result.room.id);
      openRoomView(result.room.id);

      onSuccess({ roomId: result.room.id });
    } catch (cause) {
      setError(failureText(cause, 'Could not create the room.'));
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }, [
    canSubmit,
    selectedBridge,
    workspaceId,
    trimmedName,
    trimmedDescription,
    instructions,
    agents,
    onSuccess,
    setCloseGuard,
  ]);

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canSubmit) void handleSubmit();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New room</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-6">
          {!server && (
            <p className="text-xs text-destructive">
              No Switch server is selected, so there is nowhere to create a room. Choose a server in
              the sidebar first.
            </p>
          )}

          {/* The app comes first because it decides the rest: the room's name
              becomes a channel name there, and who can reach the room is
              whoever is in that workspace. */}
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">Messaging app</span>
              <span className="text-sm text-foreground-muted">
                Where the collaboration happens — people and agents talk in this room.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {allBridges.map((bridge) => (
                <BridgeTile
                  key={bridge.id}
                  bridge={bridge}
                  identity={identities?.find((i) => i.bridgeId === bridge.id) ?? null}
                  identitiesKnown={identities !== null}
                  unusable={bridgeUnusableReason(bridge, { needsChannelCreation: true })}
                  selected={selectedBridge?.id === bridge.id}
                  onSelect={() => setBridgeId(bridge.id)}
                />
              ))}
            </div>
            {noBridgesAtAll && (
              <p className="text-xs text-destructive">
                This server has no messaging app connected, so a room created here would be
                unreachable. Connect one first.
              </p>
            )}
            {noneRunning && (
              <p className="text-xs text-destructive">
                This server&apos;s messaging apps are not running, so a room created here would be
                unreachable. Start one, or connect another.
              </p>
            )}
            {noneCanCreateChannels && (
              <p className="text-xs text-destructive">
                None of the running messaging apps can create a channel from Switch — for example, a
                Telegram bot can&apos;t create chats on its own. Make the chat directly in the
                messaging app instead (for Telegram, create the group and add the bot to it) and it
                becomes a room here once it exists.
              </p>
            )}
            {bridgesQuery.isError && (
              <p className="text-xs text-destructive">
                {failureText(bridgesQuery.error, 'Could not load messaging apps.')}
              </p>
            )}
          </section>

          <div className="flex flex-col gap-4">
            <FormRow label="Name">
              <Input
                autoFocus
                placeholder="e.g. design-review"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={submitOnEnter}
              />
              {/* What the name becomes, where it becomes it. A room is a channel
                  in the app it is bridged to, and the two names are the same
                  one — saying so here is what makes that predictable. */}
              {trimmedName !== '' && selectedBridge && (
                <span className="text-xs text-foreground-muted">
                  Created as #{trimmedName} in {selectedBridge.displayName}.
                </span>
              )}
            </FormRow>

            <FormRow label="Description">
              <Input
                placeholder="What this room is for"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setError(null);
                }}
                onKeyDown={submitOnEnter}
              />
            </FormRow>
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">Agents</span>
              {agents.length > 0 && (
                <span className="text-sm text-foreground-muted">{agents.length} added</span>
              )}
            </div>

            {agents.length > 0 && (
              <div className="grid grid-cols-3 gap-2.5">
                {agents.map((agent) => (
                  <ChosenAgentTile
                    key={agent.id}
                    agent={agent}
                    subtitle={agentProviderLabelFor(agent.id, workspaceId)}
                    onRemove={() =>
                      setAgents((current) => current.filter((a) => a.id !== agent.id))
                    }
                  />
                ))}
              </div>
            )}

            <PickerCombobox
              items={invitableAgents.filter((a) => !agents.some((s) => s.id === a.id))}
              onPick={(next) => setAgents((current) => [...current, next])}
              searchText={(item) => item.name}
              renderItem={(item) => (
                <AgentPickerRow
                  agent={item}
                  subtitle={agentProviderLabelFor(item.id, workspaceId)}
                />
              )}
              disabled={agentsQuery.isLoading}
              placeholder={agentsQuery.isLoading ? 'Loading agents…' : 'Search agents to add...'}
              emptyText="No agents found"
            />

            <span className="text-xs text-foreground-muted">
              Optional — agents can be added to the room later.
            </span>
          </section>

          <div>
            <DisclosureRow
              open={instructionsOpen}
              title="Instructions"
              meta="shown to agents when they enter"
              onToggle={() => setInstructionsOpen((v) => !v)}
            />
            {instructionsOpen && (
              <Textarea
                className="mt-3"
                placeholder="Optional guidance shown to agents when they enter a room"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
              />
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
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

/** A labelled row: the setting's name on the left, the control on the right. */
function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-24 shrink-0 pt-2 text-sm text-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** Turn a failed create into something the user can act on. */
function messageFor(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'bridge-unavailable':
      return result.message ?? 'The messaging app is not available.';
    default:
      return result.message ?? 'Could not create the room.';
  }
}
