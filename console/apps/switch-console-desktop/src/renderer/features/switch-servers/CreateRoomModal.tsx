import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { openRoomView } from '@renderer/features/sidebar/sidebar-room-grouping';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { agentProviderLabel } from '@renderer/lib/components/agent-mark';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
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
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type {
  LinkedIdentity,
  RemoteAgentSummary,
  RemoteBridge,
} from '@shared/core/switch-servers/switch-servers';
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
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
    enabled: !!serverId,
  });
  const agentsQuery = useQuery({
    queryKey: ['remote-agents', serverId],
    queryFn: () => rpc.switchServers.listRemoteAgents(serverId),
    enabled: !!serverId,
  });
  // Which account on each app is the person creating the room. A room on an app
  // they have not claimed an account on works, but their own messages in it are
  // from a stranger as far as the agents are concerned — so it is said here,
  // while the app is being chosen, rather than discovered later.
  const { identities } = useMyIdentities(serverId);

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
    agentsStore.agentsOnServer(serverId).some((local) => local.switchAgentId === remote.id)
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
    serverId,
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
                    serverId={serverId}
                    onRemove={() =>
                      setAgents((current) => current.filter((a) => a.id !== agent.id))
                    }
                  />
                ))}
              </div>
            )}

            <Combobox
              items={invitableAgents.filter((a) => !agents.some((s) => s.id === a.id))}
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
              {/* The search box is the control, rather than a button that opens
                  one: adding several agents is the normal case, and a picker
                  that has to be reopened per agent makes the normal case the
                  laborious one. */}
              <ComboboxInput
                showTrigger={false}
                disabled={agentsQuery.isLoading}
                placeholder={agentsQuery.isLoading ? 'Loading agents…' : 'Search agents to add...'}
                leftAddon={<Search className="size-3.5 text-foreground-muted" />}
              />
              <ComboboxContent className="min-w-(--anchor-width)">
                <ComboboxList>
                  {(item: RemoteAgentSummary) => (
                    <ComboboxItem key={item.id} value={item} showCheck={false}>
                      <AgentAvatar name={item.name} iconUrl={item.iconUrl} size={22} />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="shrink-0 text-xs text-foreground-muted">
                        {providerLabelFor(item.id, serverId)}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
                <ComboboxEmpty>No agents found</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>

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

/**
 * One messaging app to put the room in, with the account the user has on it.
 *
 * Every connected app is drawn, including the ones that cannot back a new room
 * — those are disabled and say why. Omitting them would be quieter and worse:
 * the user knows their server has Telegram on it, and a grid that simply does
 * not mention it reads as a bug rather than as a refusal.
 */
function BridgeTile({
  bridge,
  identity,
  identitiesKnown,
  selected,
  onSelect,
}: {
  bridge: RemoteBridge;
  identity: LinkedIdentity | null;
  identitiesKnown: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const platform = bridgePlatformLabel(bridge.type);
  const unusable =
    bridge.status !== 'active'
      ? 'Not running'
      : !bridge.channelCreationSupported
        ? `${platform} cannot create channels`
        : !bridge.canCreateChannels
          ? 'Channel creation is off'
          : null;

  return (
    <button
      type="button"
      disabled={unusable !== null}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-[10px] border p-3 text-left transition-colors',
        // Overlay tokens rather than `background-1`, which in dark mode is
        // exactly the dialog's own surface — the hover was being drawn, in the
        // colour of the thing behind it.
        selected ? 'border-foreground bg-[var(--sel)]' : 'border-border hover:bg-[var(--sel-soft)]',
        unusable !== null && 'cursor-not-allowed opacity-50 hover:bg-transparent'
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        {hasBridgeIcon(bridge.type) ? (
          <BridgeIcon bridgeType={bridge.type} size={20} />
        ) : (
          <MessageSquare className="size-5 text-foreground-muted" />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{bridge.displayName}</span>
        {/* Three different things, never conflated: why this app cannot be
            used, which account on it is you, or that Switch cannot tell. */}
        {unusable !== null ? (
          <span className="truncate text-xs text-foreground-muted">{unusable}</span>
        ) : !identitiesKnown ? null : identity === null ? (
          <span className="truncate text-xs text-amber-600 dark:text-amber-500">
            No account linked
          </span>
        ) : (
          <span className="truncate text-xs text-foreground-muted">{handleOf(identity)}</span>
        )}
      </span>
    </button>
  );
}

/** An agent already added to the room, with the way to take it back out. */
function ChosenAgentTile({
  agent,
  serverId,
  onRemove,
}: {
  agent: RemoteAgentSummary;
  serverId: string;
  onRemove: () => void;
}) {
  return (
    // `--fill` rather than `--surface-2`: in dark mode that surface is the
    // dialog's own background, so a tile drawn in it was a tile nobody could
    // see.
    <div className="group relative flex flex-col gap-2 rounded-[10px] bg-[var(--fill)] p-3">
      <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} size={26} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{agent.name}</span>
        <span className="truncate text-xs text-foreground-muted">
          {providerLabelFor(agent.id, serverId)}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Remove ${agent.name}`}
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--fill-2)] hover:text-foreground focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** This install's record of a Switch agent, which is where its provider is
 * known — the server's summary says what type it is, not what runs it here. */
function localAgentFor(switchAgentId: string, serverId: string) {
  return (
    agentsStore.agentsOnServer(serverId).find((a) => a.switchAgentId === switchAgentId) ?? null
  );
}

function providerLabelFor(switchAgentId: string, serverId: string): string {
  return agentProviderLabel(localAgentFor(switchAgentId, serverId)?.providerId);
}

/** The claimed account as a handle. Platforms differ on whether the username
 * they report already carries the sigil, so add one only when it is missing. */
function handleOf(identity: LinkedIdentity): string {
  const username = identity.externalUsername;
  return username.startsWith('@') ? username : `@${username}`;
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
