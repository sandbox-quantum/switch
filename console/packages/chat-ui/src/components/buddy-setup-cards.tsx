import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { ChatSummary } from '../contracts/chats';
import {
  type BuddyPlatform,
  type BuddyRefusal,
  type BuddyResume,
  type BuddySetupStep,
  buddyHandedOffPlatform,
  buddyHandoffRequestId,
  buddyPlatform,
  buddyRestartedHandoffRequestId,
  buddyResumeBridges,
  buddySetupStep,
  type LinkedIdentity,
  type RemoteBridge,
} from '../model/buddy-setup-step';
import { cn } from '../model/cn';
import { Button } from '../primitives/button';
import { Spinner } from '../primitives/spinner';

/**
 * What the setup cards need from the app drawing them: its reads of the
 * person's chat-app connections and linked accounts, the hand-off itself, and
 * where its own pages for connecting an app and linking an account are.
 * Console and the web dashboard each give their own.
 */
export type BuddySetupServices<B extends RemoteBridge = RemoteBridge> = {
  /** Keys the cards' cached reads, so two workspaces never share them. */
  scope: string;
  /** The workspace's chat-app connections; `refetch` reads them again. */
  useBridges: () => {
    data: B[] | null;
    isError: boolean;
    refetch: () => Promise<unknown>;
  };
  /** The person's linked accounts; `refresh` reads them again. */
  useIdentities: () => {
    identities: LinkedIdentity[] | null;
    error: unknown;
    refresh: () => void;
  };
  /** The buddy's channel on `bridge` when a hand-off was started there, finished; null when none was. */
  resume: (bridge: B, accountIds: string[]) => Promise<ChatSummary | null>;
  /** Makes the person's private channel with the buddy on `bridge`. */
  handOff: (bridge: B, requestId: string) => Promise<ChatSummary>;
  /** The linked-account refusal in a failed hand-off, else null. */
  refusalOf: (cause: unknown) => BuddyRefusal | null;
  /** A failure, in words for the person. */
  failureText: (cause: unknown, fallback: string) => string;
  /** The hand-off room's channel: its name and a link to open it in the chat app. */
  roomChannel: (roomId: string) => Promise<{
    channelName: string | null;
    channelUrl: string | null;
    createdAt: string | null;
  }>;
  /** Opens the app's own way to connect `platform`, calling `onClosed` when the person is back. */
  connect: (platform: BuddyPlatform, onClosed: () => void) => void;
  /** Opens the app's own way to link an account on `bridge`. */
  linkAccount: (bridge: B) => void;
  /** Opens where the person manages their linked accounts. */
  manageLinkedAccounts: () => void;
  /** Opens the hand-off channel in its chat app, `label` naming the app. */
  openChannel: (url: string, label: string) => void;
  /** The tile for staying in this app's own chat, and what choosing it says in the chat. */
  stay: { icon: ReactNode; name: string; message: string };
  /** Whether the person already said they stay here. */
  stayed: boolean;
  /** Says it in the chat, for the buddy to pick up. */
  onStay: () => void;
  /** A chat app's icon, drawn as the app draws it. */
  bridgeIcon: (bridgeType: string, size: number) => ReactNode;
  /** Beside the heading: what a messaging app is, where the app explains it. */
  info: ReactNode;
  /** The command to invite the buddy into a chat on `bridge`, ready to copy. */
  inviteCommand: (bridge: B, agentName: string) => ReactNode;
  /**
   * The app's step-by-step list for a chat app with no directory (Telegram),
   * from saying hello to the bot to talking to the buddy; null where the app
   * has none, which shows the plain link card instead.
   */
  checklist: (bridge: B, label: string, identities: LinkedIdentity[]) => ReactNode;
  /**
   * Whether the person is already talking to the buddy on the chat app: in a
   * group they invited it to (`groupBridge`), or in the hand-off channel
   * (`channelRoomId`). Then the cards fold into one line.
   */
  useTalking: (args: { groupBridge: B | null; linked: boolean; channelRoomId: string | null }) => {
    inGroup: boolean;
    inChannel: boolean;
  };
  /** What the buddy set up since the hand-off, where the app can list it; null for nothing. */
  createdSince: (since: string) => ReactNode;
};

/**
 * The setup cards under the greeting in the buddy's Welcome chat: pick a chat
 * app, connect it, link your account, then continue with the buddy there — in
 * a private channel made for them on Slack or Discord, by their own invite
 * elsewhere. Or stay in this app's chat, which says so in the chat for the
 * buddy to pick up.
 */
export function BuddySetupCards<B extends RemoteBridge>({
  services,
  agentId,
  agentName,
}: {
  services: BuddySetupServices<B>;
  agentId: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();
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

  const bridgesQuery = services.useBridges();
  const ids = services.useIdentities();
  const resumeBridges = buddyResumeBridges(bridgesQuery.data, ids.identities);
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
      queryFn: () => services.resume(bridge, accountIds(bridge.id)),
      retry: false,
      staleTime: Infinity,
    })),
  });
  const resumes: Record<string, BuddyResume> = {};
  resumeBridges.forEach((bridge, index) => {
    const query = resumeQueries[index];
    if (query?.isError) resumes[bridge.id] = services.refusalOf(query.error) ?? 'failed';
    else if (query?.isSuccess) resumes[bridge.id] = query.data;
  });
  if (createRefusal && resumes[createRefusal.bridgeId] === null)
    resumes[createRefusal.bridgeId] = createRefusal.refusal;
  // With nothing picked, open on the app a hand-off was already made in, once every app has answered.
  const handedOff = buddyHandedOffPlatform(resumeBridges, resumes);
  const waiting = picked === null && handedOff === undefined;
  const platform = waiting ? null : buddyPlatform(picked ?? handedOff ?? null, bridgesQuery.data);
  const label = platform ? PLATFORM_NAMES[platform] : '';
  const failed = bridgesQuery.isError || ids.error != null;
  const step: BuddySetupStep<B> =
    waiting && !failed
      ? { kind: 'resuming' }
      : buddySetupStep({
          platform,
          bridges: bridgesQuery.data,
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

  // Set up and talking to the buddy there: the cards fold into one line, and
  // open again for connecting another app.
  // Teams is guided the same way, by an invite the person sends, so it folds too.
  const checklistBridge = step.kind === 'checklist' || step.kind === 'guide' ? step.bridge : null;
  const [connectAnother, setConnectAnother] = useState(false);
  const doneRoomId = step.kind === 'done' ? step.chat.roomId : null;
  const talking = services.useTalking({
    groupBridge: checklistBridge,
    linked: (ids.identities ?? []).some((identity) => identity.bridgeId === checklistBridge?.id),
    channelRoomId: doneRoomId,
  });
  const settled =
    !connectAnother &&
    ((checklistBridge !== null && talking.inGroup) || (doneRoomId !== null && talking.inChannel));
  const roomQuery = useQuery({
    queryKey: ['buddy-handoff-room', services.scope, doneRoomId],
    queryFn: () => services.roomChannel(doneRoomId as string),
    enabled: doneRoomId !== null,
  });
  const channelUrl = roomQuery.data?.channelUrl ?? null;

  const create = async (bridge: B, requestId: string) => {
    setCreating(true);
    setCreateError(null);
    try {
      await services.handOff(bridge, requestId);
      setCreateRefusal(null);
      await queryClient.invalidateQueries({
        queryKey: ['buddy-handoff', buddyHandoffRequestId(agentId, bridge.id)],
      });
    } catch (cause) {
      const refusal = services.refusalOf(cause);
      if (refusal) setCreateRefusal({ bridgeId: bridge.id, refusal });
      else setCreateError(services.failureText(cause, 'Switch did not answer.'));
    } finally {
      setCreating(false);
    }
  };

  if (services.stayed) return null;

  const pressed = (app: BuddyPlatform) =>
    platform === app && (picked !== null || (step.kind !== 'loading' && step.kind !== 'unknown'));

  if (settled)
    return (
      <div className="mt-4 flex flex-col gap-3" data-testid="buddy-setup-cards">
        <StatusRow>
          <CheckCircle2 className="size-4 shrink-0 text-foreground-success" />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{label} is set up.</span> You’re talking to {agentName}{' '}
            there.
          </span>
          {doneRoomId && channelUrl && (
            <Button size="sm" onClick={() => services.openChannel(channelUrl, label)}>
              Open {label}
              <ArrowRight />
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setConnectAnother(true);
              setPicked(null);
            }}
          >
            Connect another app
          </Button>
        </StatusRow>
        {doneRoomId && roomQuery.data?.createdAt && services.createdSince(roomQuery.data.createdAt)}
      </div>
    );

  return (
    <div className="@container mt-4 flex flex-col gap-3" data-testid="buddy-setup-cards">
      <div className="flex items-center gap-2 font-semibold">
        Where does your team chat?
        {services.info}
      </div>
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-3 @2xl:grid-cols-5">
        {TILES.map((app) => (
          <button
            key={app.bridgeType}
            type="button"
            aria-pressed={pressed(app.bridgeType)}
            onClick={() => setPicked(app.bridgeType)}
            className={cn(
              TILE_CLASS,
              pressed(app.bridgeType) && 'border-foreground/40 shadow-sm ring-1 ring-foreground/20'
            )}
          >
            {services.bridgeIcon(app.bridgeType, 28)}
            <TileText name={app.name} subtitle={app.subtitle} />
          </button>
        ))}
        <button type="button" onClick={services.onStay} className={TILE_CLASS}>
          {services.stay.icon}
          <TileText name={services.stay.name} subtitle="Connect an app later" />
        </button>
      </div>

      {platform && step.kind === 'loading' && (
        <StatusRow>
          <Spinner size="sm" />
          Checking {label}…
        </StatusRow>
      )}

      {step.kind === 'unknown' && (
        <StatusRow className="border-border-destructive text-foreground-destructive">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Couldn’t check {label || 'your messaging apps'}</div>
            <div>Switch did not answer.</div>
          </div>
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        </StatusRow>
      )}

      {step.kind === 'refused' && (
        <PlatformCard
          icon={services.bridgeIcon(step.bridge.type, 20)}
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
                  <Button onClick={services.manageLinkedAccounts}>Manage linked accounts</Button>
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
          icon={services.bridgeIcon(step.platform, 20)}
          title={`Connect ${label}`}
          description={`Add ${label} to your Switch workspace.`}
          footer={
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => {
                  setNotConnected(null);
                  services.connect(step.platform, () => {
                    ids.refresh();
                    // Said only once the re-read is in, so a connection just made never flashes it.
                    void bridgesQuery.refetch().then(() => setNotConnected(step.platform));
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
            icon={services.bridgeIcon(step.bridge.type, 20)}
            title={`Link your ${label} account`}
            description={`So I recognise you in ${step.bridge.displayName}.`}
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
                  <Button onClick={() => services.linkAccount(step.bridge)}>Link account</Button>
                </div>
              </div>
            }
          />
        </>
      )}

      {step.kind === 'checklist' && (
        <div className="flex flex-col gap-3">
          {connectedBridges.length > 1 && (
            <BridgeChoice
              platform={step.bridge.type}
              bridges={connectedBridges}
              chosenId={step.bridge.id}
              disabled={false}
              onChoose={setChosenBridgeId}
            />
          )}
          {services.checklist(step.bridge, label, ids.identities ?? []) ?? (
            <PlatformCard
              icon={services.bridgeIcon(step.bridge.type, 20)}
              title={`Link your ${label} account`}
              description={`So I recognise you in ${step.bridge.displayName}.`}
              footer={
                <Button onClick={() => services.linkAccount(step.bridge)}>Link account</Button>
              }
            />
          )}
        </div>
      )}

      {step.kind === 'create' && (
        <>
          <div className="flex items-center gap-2 rounded-lg bg-background-success px-3 py-2 text-sm text-foreground-success">
            <CheckCircle2 className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{label} ready</span> — {label} connected · account
              linked
            </span>
            {services.bridgeIcon(step.bridge.type, 16)}
          </div>
          <PlatformCard
            icon={services.bridgeIcon(step.bridge.type, 20)}
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
            {services.bridgeIcon(step.bridge.type, 16)}
          </div>
          <PlatformCard
            icon={services.bridgeIcon(step.bridge.type, 20)}
            title={`Continue in ${label}`}
            description={`Add the Switch app to a ${label} chat or channel and send this there. Then mention ${agentName} with a short note on what you work on.`}
            footer={
              <div className="flex flex-col items-start gap-3">
                <BridgeChoice
                  platform={step.bridge.type}
                  bridges={connectedBridges}
                  chosenId={step.bridge.id}
                  disabled={false}
                  onChoose={setChosenBridgeId}
                />
                {services.inviteCommand(step.bridge, agentName)}
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
              {roomQuery.data?.channelName ?? `Private ${label} channel`} ready
            </span>
            {channelUrl ? (
              <Button size="sm" onClick={() => services.openChannel(channelUrl, label)}>
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
          {roomQuery.data?.createdAt && services.createdSince(roomQuery.data.createdAt)}
        </>
      )}
    </div>
  );
}

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
  const only = accountIds.length === 1 ? accountIds[0] : undefined;
  if (only === undefined) return null;
  return (
    <Button disabled={creating} onClick={() => onRestart(only)}>
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

const TILE_CLASS =
  'flex flex-col items-start gap-3 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-background-1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

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
  icon,
  title,
  description,
  error,
  footer,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  error?: string | null;
  footer: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="flex items-start gap-3 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border">
          {icon}
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
