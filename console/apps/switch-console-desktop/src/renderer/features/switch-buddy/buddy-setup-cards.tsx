import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { BridgeIcon } from '@renderer/lib/components/bridge-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { reportOpenAttempt } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import {
  type BuddyPlatform,
  type BuddyResume,
  buddyPlatform,
  buddyResumeBridges,
  buddySetupStep,
} from './buddy-setup-step';
import {
  BUDDY_CHAT_NAME,
  buddyHandoffRequestId,
  continueBuddyInSlack,
  resumeBuddyInSlack,
} from './open-buddy';

/** What the person says in the Welcome chat when they choose to stay in Console. */
export const BUDDY_STAY_MESSAGE = 'I’ll stay in Switch Console for now.';

/**
 * The setup cards under the greeting in the buddy's Welcome chat: pick a chat
 * app, connect it, link your account, then continue with the buddy there — in
 * a private channel made for them on Slack, by their own invite elsewhere. Or
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
  const [reopened, setReopened] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId),
  });
  const ids = useMyIdentities(workspaceId);
  const resumeBridges = buddyResumeBridges(bridgesQuery.data ?? null, ids.identities);
  const resumeQueries = useQueries({
    queries: resumeBridges.map((bridge) => ({
      queryKey: ['buddy-handoff', buddyHandoffRequestId(agentId, bridge.id)],
      queryFn: () => resumeBuddyInSlack(serverId, agentId, bridge.id),
      retry: false,
      staleTime: Infinity,
    })),
  });
  const resumes: Record<string, BuddyResume> = {};
  resumeBridges.forEach((bridge, index) => {
    const query = resumeQueries[index];
    if (query.isError) resumes[bridge.id] = 'failed';
    else if (query.isSuccess) resumes[bridge.id] = query.data;
  });
  const platform = buddyPlatform(picked, bridgesQuery.data ?? null);
  const label = platform ? PLATFORM_NAMES[platform] : '';
  const step = buddySetupStep({
    platform,
    bridges: bridgesQuery.data ?? null,
    identities: ids.identities,
    resumes,
    failed: bridgesQuery.isError || ids.error != null,
  });
  const retry = () => {
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
  const openSlack = (url: string) =>
    void reportOpenAttempt(
      rpc.switchRooms.openRoomChannel({ serverId, channelUrl: url }),
      'Could not open Slack',
      url
    );

  const create = async (bridge: RemoteBridge) => {
    setCreating(true);
    setCreateError(null);
    try {
      await continueBuddyInSlack(serverId, { agentId }, bridge.id);
      await queryClient.invalidateQueries({
        queryKey: ['buddy-handoff', buddyHandoffRequestId(agentId, bridge.id)],
      });
    } catch (cause) {
      setCreateError(failureText(cause, 'Switch did not answer.'));
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
    setReopened(false);
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

  if (stayed && !reopened)
    return (
      <div className="mt-4" data-testid="buddy-setup-cards">
        <StatusRow>
          <span className="min-w-0 flex-1 text-foreground-muted">
            Continuing here in Switch Console.
          </span>
          <Button size="sm" variant="outline" onClick={() => setReopened(true)}>
            Connect a chat app
          </Button>
        </StatusRow>
      </div>
    );

  const pressed = (app: BuddyPlatform) =>
    platform === app && (picked !== null || (step.kind !== 'loading' && step.kind !== 'unknown'));

  return (
    <div className="@container mt-4 flex flex-col gap-3" data-testid="buddy-setup-cards">
      <div className="font-semibold">Where does your team chat?</div>
      <div className="grid grid-cols-2 gap-3 @lg:grid-cols-4">
        {TILES.map((app) =>
          app.live ? (
            <button
              key={app.bridgeType}
              type="button"
              aria-pressed={pressed(app.bridgeType)}
              onClick={() => setPicked(app.bridgeType)}
              className={cn(
                'flex flex-col items-start gap-3 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-background-1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                pressed(app.bridgeType) &&
                  'border-foreground/40 shadow-sm ring-1 ring-foreground/20'
              )}
            >
              <BridgeIcon bridgeType={app.bridgeType} size={28} />
              <TileText name={app.name} subtitle={app.subtitle} />
            </button>
          ) : (
            <button
              key={app.bridgeType}
              type="button"
              aria-disabled="true"
              title="Coming soon"
              className="flex cursor-not-allowed flex-col items-start gap-3 rounded-lg border bg-background p-3 text-left opacity-50"
            >
              <BridgeIcon bridgeType={app.bridgeType} size={28} />
              <TileText name={app.name} subtitle={app.subtitle} />
              <span className="text-xs text-foreground-muted">Coming soon</span>
            </button>
          )
        )}
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

      {step.kind === 'connect' && (
        <PlatformCard
          platform={step.platform}
          title={`Connect ${label}`}
          description={`Add ${label} to your Switch workspace.`}
          footer={
            <Button
              onClick={() => showConnect({ serverId, platform: step.platform, onClosed: retry })}
            >
              Connect {label}
            </Button>
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
            }
          />
        </>
      )}

      {step.kind === 'create' && (
        <>
          <div className="flex items-center gap-2 rounded-lg bg-background-success px-3 py-2 text-sm text-foreground-success">
            <CheckCircle2 className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">Slack ready</span> — Slack connected · account linked
            </span>
            <BridgeIcon bridgeType="slack" size={16} />
          </div>
          <PlatformCard
            platform="slack"
            title="Continue in a private Slack channel"
            description="I’ll create a private channel just for us and continue there."
            error={createError}
            footer={
              <Button disabled={creating} onClick={() => void create(step.bridge)}>
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
            footer={<InviteCommand platform={step.bridge.type} agentName={agentName} />}
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
              {roomQuery.data?.linkedChannelName ?? 'Private Slack channel'} ready
            </span>
            {channelUrl ? (
              <Button size="sm" onClick={() => openSlack(channelUrl)}>
                Open Slack
                <ArrowRight />
              </Button>
            ) : (
              <span className="text-foreground-muted">
                {roomQuery.isPending
                  ? 'Looking up the Slack channel…'
                  : 'Couldn’t get a link to the Slack channel. Find it in Slack.'}
              </span>
            )}
          </StatusRow>
          <div className="self-start rounded-full border bg-background-1 px-3 py-1 text-sm text-foreground-muted">
            💡 <span className="font-semibold text-foreground">Private channel</span> — only you and
            buddy can see it. Just reply, no @ needed.
          </div>
        </>
      )}
    </div>
  );
});

const PLATFORM_NAMES: Record<BuddyPlatform, string> = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
};

const TILES = [
  { live: true, bridgeType: 'slack', name: 'Slack', subtitle: 'Channels & DMs' },
  { live: true, bridgeType: 'teams', name: 'Microsoft Teams', subtitle: 'Teams & chats' },
  { live: false, bridgeType: 'discord', name: 'Discord', subtitle: 'Servers & channels' },
  { live: true, bridgeType: 'telegram', name: 'Telegram', subtitle: 'Groups & chats' },
] as const;

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
