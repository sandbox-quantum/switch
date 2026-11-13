import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { followConsoleLink } from '@renderer/features/deeplinks/console-link-handler';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { BridgeIcon } from '@renderer/lib/components/bridge-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { reportOpenAttempt } from '@renderer/lib/open-external';
import { appState } from '@renderer/lib/stores/app-state';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import { consoleLink } from '@shared/core/deeplinks/console-links';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import {
  type BuddyPlatform,
  type BuddyRefusal,
  type BuddyResume,
  type BuddySetupStep,
  buddyHandedOffPlatform,
  buddyHandoffRefusal,
  buddyPlatform,
  buddyResumeBridges,
  buddySetupStep,
} from './buddy-setup-step';
import {
  BUDDY_CHAT_NAME,
  buddyHandoffRequestId,
  buddyRestartedHandoffRequestId,
  continueBuddyInChannel,
  resumeBuddyInChannel,
} from './open-buddy';

/** What the person says in the Welcome chat when they choose to stay in Console. */
export const BUDDY_STAY_MESSAGE = 'I’ll stay in Switch Console for now.';

/**
 * The setup cards under the greeting in the buddy's Welcome chat: pick a chat
 * app, connect it, link your account, then continue with the buddy there — in
 * a private channel made for them on Slack or Discord, by their own invite elsewhere. Or
 * stay here, which says so in the chat for the buddy to pick up. Drawn only in
 * the Welcome chat.
 */
export const BuddySetupCards = observer(function BuddySetupCards({
  serverId,
  workspaceId,
  agentId,
  agentName,
  roomId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  roomId: string;
}) {
  const chat = chatsStore.chat(roomId);
  if (!chat || chat.name !== BUDDY_CHAT_NAME || chat.bridgeType !== null) return null;
  return (
    <Cards
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      agentName={agentName}
      roomId={roomId}
    />
  );
});

const Cards = observer(function Cards({
  serverId,
  workspaceId,
  agentId,
  agentName,
  roomId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  roomId: string;
}) {
  const queryClient = useQueryClient();
  const showConnect = useShowModal('connectMessagingAppModal');
  const showClaimIdentity = useShowModal('claimIdentityModal');
  const [picked, setPicked] = useState<BuddyPlatform | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // A refusal from creating the hand-off answers for that connection, as a resume's would.
  const [createRefusal, setCreateRefusal] = useState<{
    bridgeId: string;
    refusal: BuddyRefusal;
  } | null>(null);
  const [notConnected, setNotConnected] = useState<BuddyPlatform | null>(null);
  const [chosenBridgeId, setChosenBridgeId] = useState<string | null>(null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId),
  });
  const ids = useMyIdentities(workspaceId);
  const resumeBridges = buddyResumeBridges(bridgesQuery.data ?? null, ids.identities);
  const accountIds = (bridgeId: string) =>
    (ids.identities ?? [])
      .filter((identity) => identity.bridgeId === bridgeId)
      .map((identity) => identity.externalUserId);
  const resumeQueries = useQueries({
    queries: resumeBridges.map((bridge) => ({
      // Keyed by the linked accounts too, so linking or unlinking one reads it again.
      queryKey: [
        'buddy-handoff',
        buddyHandoffRequestId(agentId, bridge.id),
        ...accountIds(bridge.id),
      ],
      queryFn: () => resumeBuddyInChannel(serverId, agentId, bridge, accountIds(bridge.id)),
      retry: false,
      staleTime: Infinity,
    })),
  });
  const resumes: Record<string, BuddyResume> = {};
  resumeBridges.forEach((bridge, index) => {
    const query = resumeQueries[index];
    if (query.isError) resumes[bridge.id] = buddyHandoffRefusal(query.error) ?? 'failed';
    else if (query.isSuccess) resumes[bridge.id] = query.data;
  });
  if (createRefusal && resumes[createRefusal.bridgeId] === null)
    resumes[createRefusal.bridgeId] = createRefusal.refusal;
  // With nothing picked, open on the app a hand-off was already made in, once every app has answered.
  const handedOff = buddyHandedOffPlatform(resumeBridges, resumes);
  const waiting = picked === null && handedOff === undefined;
  const platform = waiting
    ? null
    : buddyPlatform(picked ?? handedOff ?? null, bridgesQuery.data ?? null);
  const label = platform ? PLATFORM_NAMES[platform] : '';
  const failed = bridgesQuery.isError || ids.error != null;
  const step: BuddySetupStep =
    waiting && !failed
      ? { kind: 'resuming' }
      : buddySetupStep({
          platform,
          bridges: bridgesQuery.data ?? null,
          identities: ids.identities,
          resumes,
          chosenBridgeId,
          failed,
        });
  // Every connected one of the app is a choice, linked or not; the cards follow the one chosen.
  const connectedBridges = (bridgesQuery.data ?? []).filter(
    (bridge) => bridge.type === platform && bridge.status === 'active'
  );
  const retry = () => {
    setCreateRefusal(null);
    void bridgesQuery.refetch();
    ids.refresh();
    for (const query of resumeQueries) if (query.isError) void query.refetch();
  };

  const doneRoomId = step.kind === 'done' ? step.chat.roomId : null;
  const roomQuery = useQuery({
    queryKey: ['buddy-handoff-room', workspaceId, doneRoomId],
    queryFn: () => rpc.workspaces.getRoomDetail({ workspaceId, roomId: doneRoomId as string }),
    enabled: doneRoomId !== null,
  });
  const channelUrl = roomQuery.data?.externalChannelUrl ?? null;
  const openChannel = (url: string) =>
    void reportOpenAttempt(
      rpc.switchRooms.openRoomChannel({ serverId, channelUrl: url }),
      `Could not open ${label}`,
      url
    );

  const create = async (bridge: RemoteBridge, requestId: string) => {
    setCreating(true);
    setCreateError(null);
    try {
      await continueBuddyInChannel(serverId, { agentId }, bridge, requestId);
      setCreateRefusal(null);
      await queryClient.invalidateQueries({
        queryKey: ['buddy-handoff', buddyHandoffRequestId(agentId, bridge.id)],
      });
    } catch (cause) {
      const refusal = buddyHandoffRefusal(cause);
      if (refusal) setCreateRefusal({ bridgeId: bridge.id, refusal });
      else setCreateError(failureText(cause, 'Switch did not answer.'));
    } finally {
      setCreating(false);
    }
  };

  const timeline = chatsStore.timelines.get(serverId, roomId);
  const stayed =
    timeline.messages.some(
      (message) => message.sender.kind === 'human' && message.body === BUDDY_STAY_MESSAGE
    ) || timeline.pending.some((send) => send.body === BUDDY_STAY_MESSAGE);
  const stay = () => {
    timeline.send({
      body: BUDDY_STAY_MESSAGE,
      threadRootId: null,
      mentionAgentIds: [],
      mentionUserIds: [],
      mentionSpans: [],
      files: [],
      requestId: null,
    });
  };

  if (stayed) return null;

  const pressed = (app: BuddyPlatform) =>
    platform === app && (picked !== null || (step.kind !== 'loading' && step.kind !== 'unknown'));

  return (
    <div className="@container mt-4 flex flex-col gap-3" data-testid="buddy-setup-cards">
      <div className="font-semibold">Where does your team chat?</div>
      <div className="grid grid-cols-2 gap-3 @lg:grid-cols-4">
        {TILES.map((app) => (
          <button
            key={app.bridgeType}
            type="button"
            aria-pressed={pressed(app.bridgeType)}
            onClick={() => setPicked(app.bridgeType)}
            className={cn(
              'flex flex-col items-start gap-3 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-background-1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              pressed(app.bridgeType) && 'border-foreground/40 shadow-sm ring-1 ring-foreground/20'
            )}
          >
            <BridgeIcon bridgeType={app.bridgeType} size={28} />
            <TileText name={app.name} subtitle={app.subtitle} />
          </button>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="self-start" onClick={stay}>
        No chat app? Continue here in Switch Console
        <ArrowRight />
      </Button>

      {platform && step.kind === 'loading' && (
        <StatusRow>
          <Spinner size="sm" />
          Checking {label}…
        </StatusRow>
      )}

      {step.kind === 'unknown' && (
        <StatusRow className="border-border-destructive text-foreground-destructive">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Couldn’t check {label || 'your chat apps'}</div>
            <div>Switch did not answer.</div>
          </div>
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        </StatusRow>
      )}

      {step.kind === 'refused' && (
        <PlatformCard
          platform={step.bridge.type}
          title={
            step.refusal.code === 'ACCOUNTS_AMBIGUOUS'
              ? `More than one ${label} account is linked`
              : `Your linked ${label} account changed`
          }
          description={
            step.refusal.code === 'ACCOUNTS_AMBIGUOUS'
              ? `Unlink the ${label} account you no longer use, then retry.`
              : `Your first channel was made for the account linked before. I can start again in a new channel with the account linked now.`
          }
          error={step.refusal.message}
          footer={
            <div className="flex flex-wrap items-center gap-3">
              {step.refusal.code === 'ACCOUNTS_AMBIGUOUS' ? (
                <>
                  <Button
                    onClick={() =>
                      appState.navigation.navigate('settings', { tab: 'messaging-apps' })
                    }
                  >
                    Manage linked accounts
                  </Button>
                  <Button variant="outline" onClick={retry}>
                    Retry
                  </Button>
                </>
              ) : (
                <RestartButton
                  creating={creating}
                  accountIds={accountIds(step.bridge.id)}
                  onRestart={(accountId) =>
                    void create(
                      step.bridge,
                      buddyRestartedHandoffRequestId(agentId, step.bridge.id, accountId)
                    )
                  }
                />
              )}
              {createError && (
                <span className="text-sm text-foreground-destructive">{createError}</span>
              )}
            </div>
          }
        />
      )}

      {step.kind === 'connect' && (
        <PlatformCard
          platform={step.platform}
          title={`Connect ${label}`}
          description={`Add ${label} to your Switch workspace.`}
          footer={
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => {
                  setNotConnected(null);
                  showConnect({
                    serverId,
                    platform: step.platform,
                    // Said only once the re-read is in, so a connection just made never flashes it.
                    onClosed: () => {
                      ids.refresh();
                      void bridgesQuery.refetch().then(() => setNotConnected(step.platform));
                    },
                  });
                }}
              >
                Connect {label}
              </Button>
              {notConnected === step.platform && (
                <span className="text-sm text-foreground-muted">
                  {label} isn’t connected yet. Try again when you’re ready.
                </span>
              )}
            </div>
          }
        />
      )}

      {step.kind === 'link' && (
        <>
          <div className="flex items-center gap-2 text-sm text-foreground-success">
            <CheckCircle2 className="size-4" />
            {label} connected
          </div>
          <PlatformCard
            platform={step.bridge.type}
            title={`Link your ${label} account`}
            description={
              // The bot can find only people who have written where it can hear them, and
              // privacy mode lets it hear only slash commands.
              step.bridge.type === 'telegram'
                ? `I answer only accounts I recognise. Make a Telegram group with just you and the ${step.bridge.displayName} bot, and send this in it. Then link your account here: Switch shows a code to send in that group. Once it's linked, I'll answer when you reply to the bot's message there.`
                : `So I recognise you in ${step.bridge.displayName}.`
            }
            footer={
              <div className="flex flex-col items-start gap-3">
                <BridgeChoice
                  platform={step.bridge.type}
                  bridges={connectedBridges}
                  chosenId={step.bridge.id}
                  disabled={false}
                  onChoose={setChosenBridgeId}
                />
                <div className="flex flex-wrap items-center gap-3">
                  {step.bridge.type === 'telegram' && (
                    <InviteCommand platform="telegram" agentName={agentName} />
                  )}
                  <Button
                    onClick={() => showClaimIdentity({ workspaceId, bridgeId: step.bridge.id })}
                  >
                    Link account
                  </Button>
                </div>
              </div>
            }
          />
        </>
      )}

      {step.kind === 'create' && (
        <>
          <div className="flex items-center gap-2 rounded-lg bg-background-success px-3 py-2 text-sm text-foreground-success">
            <CheckCircle2 className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{label} ready</span> — {label} connected · account
              linked
            </span>
            <BridgeIcon bridgeType={step.bridge.type} size={16} />
          </div>
          <PlatformCard
            platform={step.bridge.type}
            title={`Continue in a private ${label} channel`}
            description="I’ll create a private channel just for us and continue there."
            error={createError}
            footer={
              <div className="flex flex-col items-start gap-3">
                <BridgeChoice
                  platform={step.bridge.type}
                  bridges={connectedBridges}
                  chosenId={step.bridge.id}
                  disabled={creating}
                  onChoose={setChosenBridgeId}
                />
                <Button
                  disabled={creating}
                  onClick={() =>
                    void create(step.bridge, buddyHandoffRequestId(agentId, step.bridge.id))
                  }
                >
                  {creating ? (
                    <>
                      <Spinner size="sm" />
                      Creating channel…
                    </>
                  ) : createError ? (
                    'Try again'
                  ) : (
                    <>
                      Create channel and continue
                      <ArrowRight />
                    </>
                  )}
                </Button>
              </div>
            }
          />
        </>
      )}

      {step.kind === 'guide' && (
        <>
          <div className="flex items-center gap-2 rounded-lg bg-background-success px-3 py-2 text-sm text-foreground-success">
            <CheckCircle2 className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{label} ready</span>
            </span>
            <BridgeIcon bridgeType={step.bridge.type} size={16} />
          </div>
          <PlatformCard
            platform={step.bridge.type}
            title={`Continue in ${label}`}
            description={
              step.bridge.type === 'telegram'
                ? `In a Telegram group with you and the ${step.bridge.displayName} bot, send this if you haven't yet. Then reply to the bot's message, mention ${agentName} in that reply, and say what you work on.`
                : `Add the Switch app to a Teams chat or channel and send this there. Then mention ${agentName} with a short note on what you work on.`
            }
            footer={
              <div className="flex flex-col items-start gap-3">
                <BridgeChoice
                  platform={step.bridge.type}
                  bridges={connectedBridges}
                  chosenId={step.bridge.id}
                  disabled={false}
                  onChoose={setChosenBridgeId}
                />
                <InviteCommand platform={step.bridge.type} agentName={agentName} />
              </div>
            }
          />
        </>
      )}

      {step.kind === 'resuming' && (
        <StatusRow>
          <Spinner size="sm" />
          Finishing setup…
        </StatusRow>
      )}

      {doneRoomId && (
        <>
          <StatusRow>
            <CheckCircle2 className="size-4 shrink-0 text-foreground-success" />
            <span className="min-w-0 flex-1 truncate text-foreground-success">
              {roomQuery.data?.linkedChannelName ?? `Private ${label} channel`} ready
            </span>
            {channelUrl ? (
              <Button size="sm" onClick={() => openChannel(channelUrl)}>
                Open {label}
                <ArrowRight />
              </Button>
            ) : (
              <span className="text-foreground-muted">
                {roomQuery.isPending
                  ? `Looking up the ${label} channel…`
                  : `Couldn’t get a link to the ${label} channel. Find it in ${label}.`}
              </span>
            )}
          </StatusRow>
          <div className="self-start rounded-full border bg-background-1 px-3 py-1 text-sm text-foreground-muted">
            💡 <span className="font-semibold text-foreground">Private channel</span> — only you and
            buddy can see it. Just reply, no @ needed.
          </div>
          {roomQuery.data?.createdAt && (
            <CreatedSince
              workspaceId={workspaceId}
              buddyId={agentId}
              since={roomQuery.data.createdAt}
            />
          )}
        </>
      )}
    </div>
  );
});

/**
 * The agents the person owns made since the hand-off, each with the rooms it is
 * in, linked to their pages here: what the buddy set up over in the chat app.
 * Nothing at all while there are none.
 */
const CreatedSince = observer(function CreatedSince({
  workspaceId,
  buddyId,
  since,
}: {
  workspaceId: string;
  buddyId: string;
  since: string;
}) {
  const agents = (useWorkspaceAgents(workspaceId).data ?? []).filter(
    (agent) =>
      agent.id !== buddyId &&
      agent.ownerId !== null &&
      agent.ownerId === chatsStore.userId &&
      Date.parse(agent.createdAt) > Date.parse(since)
  );
  const rooms = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ['buddy-created-agent-rooms', workspaceId, agent.id],
      queryFn: () => rpc.workspaces.listAgentRooms({ workspaceId, agentId: agent.id }),
    })),
  });
  // Agents also sit in rooms made before the hand-off (a bridge's default channels): name only newer ones.
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', workspaceId],
    queryFn: () => rpc.workspaces.listRooms(workspaceId),
  });
  const newRoom = new Set(
    (roomsQuery.data ?? [])
      .filter((room) => Date.parse(room.createdAt) > Date.parse(since))
      .map((room) => room.id)
  );
  if (agents.length === 0) return null;
  const link = (label: string, url: string) => (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-foreground underline underline-offset-2"
      onClick={() => followConsoleLink(url)}
    >
      {label}
    </Button>
  );
  return (
    <div data-testid="buddy-created-since" className="text-sm text-foreground-muted">
      Created since:{' '}
      {agents.map((agent, index) => (
        <span key={agent.id}>
          {index > 0 && ', '}
          {link(agent.displayName ?? agent.name, consoleLink('agent', { id: agent.id }))}
          {(rooms[index]?.data ?? [])
            .filter((room) => !room.archived && newRoom.has(room.roomId))
            .map((room) => (
              <span key={room.roomId}>
                {' · '}
                {link(room.roomName, consoleLink('room', { id: room.roomId }))} room
              </span>
            ))}
        </span>
      ))}
    </div>
  );
});

/** Starts a new hand-off for the one account linked now; with none or several there is no one to start it for. */
function RestartButton({
  creating,
  accountIds,
  onRestart,
}: {
  creating: boolean;
  accountIds: string[];
  onRestart: (accountId: string) => void;
}) {
  if (accountIds.length !== 1) return null;
  return (
    <Button disabled={creating} onClick={() => onRestart(accountIds[0])}>
      {creating ? (
        <>
          <Spinner size="sm" />
          Creating channel…
        </>
      ) : (
        <>
          Start again with your new account
          <ArrowRight />
        </>
      )}
    </Button>
  );
}

const PLATFORM_NAMES: Record<BuddyPlatform, string> = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
  discord: 'Discord',
  telegram: 'Telegram',
};

const TILES = [
  { bridgeType: 'slack', name: 'Slack', subtitle: 'Channels & DMs' },
  { bridgeType: 'teams', name: 'Microsoft Teams', subtitle: 'Teams & chats' },
  { bridgeType: 'discord', name: 'Discord', subtitle: 'Servers & channels' },
  { bridgeType: 'telegram', name: 'Telegram', subtitle: 'Groups & chats' },
] as const;

/** Which of the app's connections, when there is more than one to choose from. */
function BridgeChoice({
  platform,
  bridges,
  chosenId,
  disabled,
  onChoose,
}: {
  platform: string;
  bridges: RemoteBridge[];
  chosenId: string;
  disabled: boolean;
  onChoose: (bridgeId: string) => void;
}) {
  if (bridges.length < 2) return null;
  const label = PLATFORM_NAMES[platform as BuddyPlatform];
  const unit = platform === 'discord' ? 'server' : 'workspace';
  return (
    <div
      role="group"
      aria-label={`${label} ${unit}`}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="text-foreground-muted">Which {unit}?</span>
      {bridges.map((bridge) => (
        <Button
          key={bridge.id}
          size="sm"
          variant={bridge.id === chosenId ? 'default' : 'outline'}
          aria-pressed={bridge.id === chosenId}
          disabled={disabled}
          onClick={() => onChoose(bridge.id)}
        >
          {bridge.displayName}
        </Button>
      ))}
    </div>
  );
}

function TileText({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <div>
      <div className="font-semibold">{name}</div>
      <div className="text-sm text-foreground-muted">{subtitle}</div>
    </div>
  );
}

/** Telegram's bot sees only slash commands in a group where it is not an admin. */
function InviteCommand({ platform, agentName }: { platform: string; agentName: string }) {
  return (
    <code className="rounded bg-background px-2 py-1 font-mono text-sm select-all">
      {platform === 'telegram' ? '/invite_agent' : '!invite-agent'} @{agentName}
    </code>
  );
}

function StatusRow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm',
        className
      )}
    >
      {children}
    </div>
  );
}

function PlatformCard({
  platform,
  title,
  description,
  error,
  footer,
}: {
  platform: string;
  title: string;
  description: string;
  error?: string | null;
  footer: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="flex items-start gap-3 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border">
          <BridgeIcon bridgeType={platform} size={20} />
        </div>
        <div className="min-w-0">
          <div className="font-semibold">{title}</div>
          <div className="text-sm text-foreground-muted">{description}</div>
          {error && <div className="mt-1 text-sm text-foreground-destructive">{error}</div>}
        </div>
      </div>
      <div className="border-t bg-background-1 px-4 py-3">{footer}</div>
    </div>
  );
}
