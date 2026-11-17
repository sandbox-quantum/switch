import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { claimFailureText } from '@renderer/features/switch-servers/bridge-identity-search';
import { BridgeIcon } from '@renderer/lib/components/bridge-icon';
import { CopyCommand } from '@renderer/lib/components/copy-command';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { reportOpenAttempt } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type {
  BridgePerson,
  LinkedIdentity,
  RemoteAgentRoom,
  RemoteBridge,
  RemoteRoomSummary,
} from '@shared/core/switch-servers/switch-servers';
import { typedCommand } from '@shared/core/switch-servers/typed-command';

/** How often the people the bot has seen are read while waiting for a hello. */
export const SEEN_POLL_MS = 3000;

/** At most this many of the newest accounts are offered as "is this you?". */
const MAX_CANDIDATES = 3;

/**
 * Getting going with the buddy on a chat app that has no directory to pick
 * yourself from (Telegram): one list, in the order it is done. Say hello to
 * the bot so Switch sees your account; say which account is you and confirm
 * it; make a group with the buddy; tell it what you work on. Each step shows
 * done once Switch can tell it is, and the next one is the one to do.
 */
export function ChatAppChecklist({
  serverId,
  workspaceId,
  bridge,
  label,
  agentId,
  agentName,
  identities,
  onIdentitiesChanged,
}: {
  serverId: string;
  workspaceId: string;
  bridge: RemoteBridge;
  label: string;
  agentId: string;
  agentName: string;
  identities: LinkedIdentity[];
  onIdentitiesChanged: () => void;
}) {
  const showClaimIdentity = useShowModal('claimIdentityModal');
  const linked = identities.find((identity) => identity.bridgeId === bridge.id) ?? null;
  const peopleQuery = useQuery({
    queryKey: ['bridge-people', workspaceId, bridge.id],
    queryFn: () => rpc.workspaces.listBridgePeople({ workspaceId, bridgeId: bridge.id }),
    refetchInterval: linked ? false : SEEN_POLL_MS,
  });
  const candidates = newestUnlinked(peopleQuery.data ?? []);
  // In a group: the buddy is in a room on this app other than the bot's
  // direct chat. Read while linked and not there yet.
  const inGroupQuery = useQuery({
    queryKey: ['buddy-in-group', workspaceId, agentId, bridge.type],
    queryFn: async () => {
      const [agentRooms, rooms] = await Promise.all([
        rpc.workspaces.listAgentRooms({ workspaceId, agentId }),
        rpc.workspaces.listRooms(workspaceId),
      ]);
      return inAGroupOn(bridge.type, agentRooms, rooms);
    },
    enabled: linked !== null,
    refetchInterval: (query) => (query.state.data ? false : SEEN_POLL_MS),
  });
  const inGroup = inGroupQuery.data === true;
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const claim = async (person: BridgePerson) => {
    setClaiming(person.externalUserId);
    setClaimError(null);
    try {
      const result = await rpc.workspaces.claimBridgeIdentity({
        workspaceId,
        bridgeId: bridge.id,
        externalUserId: person.externalUserId,
        username: person.username,
      });
      if (result.kind === 'pending') {
        onIdentitiesChanged();
        showClaimIdentity({
          workspaceId,
          bridgeId: bridge.id,
          confirm: {
            identityId: result.pending.id,
            externalUsername: result.pending.externalUsername,
            kind: result.alreadyLinked ? 'unverified' : 'pending',
          },
          confirmCode: result.code,
          onSuccess: onIdentitiesChanged,
          onClose: onIdentitiesChanged,
        });
        return;
      }
      if (result.kind !== 'claimed') {
        setClaimError(claimFailureText(result));
        return;
      }
      onIdentitiesChanged();
    } catch (cause) {
      setClaimError(failureText(cause, 'Could not link this account.'));
    } finally {
      setClaiming(null);
    }
  };

  const seen = linked !== null || candidates.length > 0;
  const bot = bridge.displayName;
  const invite = typedCommand(bridge, 'invite-agent', { agent: agentName });

  return (
    <div
      className="overflow-hidden rounded-xl border bg-background"
      data-testid="chat-app-checklist"
    >
      <div className="flex items-center gap-3 border-b p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border">
          <BridgeIcon bridgeType={bridge.type} size={20} />
        </div>
        <div className="min-w-0">
          <div className="font-semibold">Set up {label}</div>
          <div className="text-sm text-foreground-muted">
            {label} connected. Four steps and I’ll be with you there.
          </div>
        </div>
      </div>
      <ol className="flex flex-col divide-y">
        <Step
          n={1}
          done={seen}
          current={!seen}
          title={`Say hello to the ${bot} bot`}
          detail={
            seen
              ? linked
                ? `Seen you as ${handle(linked.externalUsername)}.`
                : `Seen you as ${handle(candidates[0].username)}.`
              : `Open the bot in ${label} and press Start (or send it “hello”), so Switch knows your account.`
          }
        >
          {!seen && (
            <div className="flex flex-wrap items-center gap-3">
              {bridge.homeUrl && (
                <Button
                  size="sm"
                  onClick={() =>
                    void reportOpenAttempt(
                      rpc.switchRooms.openRoomChannel({
                        serverId,
                        channelUrl: helloUrl(bridge.homeUrl!),
                      }),
                      `Could not open ${label}`,
                      helloUrl(bridge.homeUrl!)
                    )
                  }
                >
                  Open in {label}
                </Button>
              )}
              <span className="flex items-center gap-2 text-sm text-foreground-muted">
                <Spinner size="sm" />
                Waiting for your hello…
              </span>
            </div>
          )}
        </Step>
        <Step
          n={2}
          done={linked !== null && linked.verified}
          current={seen && !(linked !== null && linked.verified)}
          title="Is this you?"
          detail={
            linked
              ? linked.verified
                ? `Linked as ${handle(linked.externalUsername)}. I’ll answer you there.`
                : `Linked as ${handle(linked.externalUsername)}. Confirm it with a code to finish.`
              : 'I answer only accounts I recognise. Pick yours and confirm it.'
          }
        >
          {seen && !linked && (
            <div className="flex flex-col items-start gap-2">
              {candidates.map((person) => (
                <div key={person.externalUserId} className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{handle(person.username)}</span>
                  <Button size="sm" disabled={claiming !== null} onClick={() => void claim(person)}>
                    {claiming === person.externalUserId ? <Spinner size="sm" /> : 'That’s me'}
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0"
                onClick={() =>
                  showClaimIdentity({
                    workspaceId,
                    bridgeId: bridge.id,
                    onSuccess: onIdentitiesChanged,
                    onClose: onIdentitiesChanged,
                  })
                }
              >
                Not listed? Search for your account
              </Button>
              {claimError && (
                <span className="text-sm text-foreground-destructive">{claimError}</span>
              )}
            </div>
          )}
          {linked && !linked.verified && (
            <Button
              size="sm"
              onClick={() =>
                showClaimIdentity({
                  workspaceId,
                  bridgeId: bridge.id,
                  confirm: {
                    identityId: linked.id,
                    externalUsername: linked.externalUsername,
                    kind: 'unverified',
                  },
                  onSuccess: onIdentitiesChanged,
                  onClose: onIdentitiesChanged,
                })
              }
            >
              Confirm with a code
            </Button>
          )}
        </Step>
        <Step
          n={3}
          done={inGroup}
          current={linked !== null && !inGroup}
          title={`Make a group with ${agentName}`}
          detail={
            inGroup
              ? `${agentName} is in a ${label} group with you.`
              : `Create a ${label} group with you and the ${bot} bot, then send this in it:`
          }
        >
          {!inGroup && <CopyCommand command={invite} />}
        </Step>
        <Step
          n={4}
          done={false}
          current={inGroup}
          title={`Tell ${agentName} what you work on`}
          detail={`In that group, reply to the bot’s message, mention ${agentName}, and say what you work on.`}
        />
      </ol>
    </div>
  );
}

/**
 * The bot's link, with a start parameter: Telegram offers Start again only to
 * a link carrying one, so someone who has used the bot before can still say
 * hello with a tap. A link that already has a query is left alone.
 */
export function helloUrl(homeUrl: string): string {
  return homeUrl.includes('?') ? homeUrl : `${homeUrl}?start=hello`;
}

/** Whether the agent is in a room on this app that is not a direct chat with the app. */
export function inAGroupOn(
  bridgeType: string,
  agentRooms: RemoteAgentRoom[],
  rooms: RemoteRoomSummary[]
): boolean {
  const onApp = new Set(
    rooms
      .filter((room) => room.bridgeType === bridgeType && room.channelType !== 'lobby')
      .map((room) => room.id)
  );
  return agentRooms.some((room) => !room.archived && onApp.has(room.roomId));
}

/** Accounts nobody has linked yet, newest first: likeliest the one just seen. */
export function newestUnlinked(people: BridgePerson[]): BridgePerson[] {
  return people
    .filter((person) => person.linkedUserIds.length === 0)
    .sort((a, b) => (b.firstSeenAt ?? '').localeCompare(a.firstSeenAt ?? ''))
    .slice(0, MAX_CANDIDATES);
}

function handle(username: string): string {
  return username.startsWith('@') ? username : `@${username}`;
}

function Step({
  n,
  done,
  current,
  title,
  detail,
  children,
}: {
  n: number;
  done: boolean;
  current: boolean;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <li
      className={cn('flex gap-3 px-4 py-3', !done && !current && 'opacity-60')}
      aria-current={current ? 'step' : undefined}
      data-done={done}
    >
      <div className="pt-0.5">
        {done ? (
          <CheckCircle2 className="size-5 text-foreground-success" aria-label="Done" />
        ) : (
          <Circle className="size-5 text-foreground-passive" aria-label={`Step ${n}`} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <div className="font-semibold">{title}</div>
          <div className="text-sm text-foreground-muted">{detail}</div>
        </div>
        {children}
      </div>
    </li>
  );
}
