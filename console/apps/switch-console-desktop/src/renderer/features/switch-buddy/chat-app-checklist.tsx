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
  const { inGroup, talking } = useGroupProgress({
    workspaceId,
    agentId,
    bridge,
    enabled: linked !== null,
  });
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
  const groupUrl = groupInviteUrl(bridge, agentName);
  const open = (url: string) =>
    void reportOpenAttempt(
      rpc.switchRooms.openRoomChannel({ serverId, channelUrl: url }),
      `Could not open ${label}`,
      url
    );

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
                <Button size="sm" onClick={() => open(helloUrl(bridge.homeUrl!))}>
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
          {!inGroup && (
            <div className="flex flex-col items-start gap-2">
              {groupUrl && (
                <Button size="sm" onClick={() => open(groupUrl)}>
                  Add the bot to a group
                </Button>
              )}
              {groupUrl && (
                <span className="text-sm text-foreground-muted">
                  Pick a group with just you in it, and {agentName} joins with the bot. Or send this
                  in the group yourself:
                </span>
              )}
              <CopyCommand command={invite} />
            </div>
          )}
        </Step>
        <Step
          n={4}
          done={talking}
          current={inGroup && !talking}
          title={`Tell ${agentName} what you work on`}
          detail={
            talking
              ? `You’re talking to ${agentName} there.`
              : `In that group, mention ${agentName} and say what you work on.`
          }
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

/**
 * Telegram's add-to-a-group link for the bot, naming the agent to invite as
 * it joins (`startgroup=invite-<agent>`, which the bridge reads as the
 * invite command), or null where there is none: another platform, no bot
 * link, or an agent name Telegram will not carry in a start parameter.
 */
export function groupInviteUrl(
  bridge: Pick<RemoteBridge, 'type' | 'homeUrl'>,
  agentName: string
): string | null {
  if (bridge.type !== 'telegram' || !bridge.homeUrl || bridge.homeUrl.includes('?')) return null;
  const payload = `invite-${agentName}`;
  return /^[A-Za-z0-9_-]{1,64}$/.test(payload) ? `${bridge.homeUrl}?startgroup=${payload}` : null;
}

/**
 * Whether the buddy is in a group on this app with the person, and whether
 * they have talked to it there. Read while not yet talking; once seen talking
 * it is remembered on this machine, since the session that showed it moves on.
 */
export function useGroupProgress({
  workspaceId,
  agentId,
  bridge,
  enabled,
}: {
  workspaceId: string;
  agentId: string;
  bridge: Pick<RemoteBridge, 'id' | 'type'> | null;
  enabled: boolean;
}): { inGroup: boolean; talking: boolean } {
  const key = `switch-buddy:talking:${workspaceId}:${agentId}:${bridge?.id ?? ''}`;
  const remembered = bridge !== null && readFlag(key);
  const query = useQuery({
    queryKey: ['buddy-in-group', workspaceId, agentId, bridge?.type],
    queryFn: async () => {
      const [agentRooms, rooms] = await Promise.all([
        rpc.workspaces.listAgentRooms({ workspaceId, agentId }),
        rpc.workspaces.listRooms(workspaceId),
      ]);
      return groupProgress(bridge?.type ?? '', agentRooms, rooms);
    },
    enabled: enabled && bridge !== null && !remembered,
    refetchInterval: (q) => (q.state.data?.talking ? false : SEEN_POLL_MS),
  });
  const talking = remembered || query.data?.talking === true;
  if (talking && !remembered) writeFlag(key);
  return { inGroup: talking || query.data?.inGroup === true, talking };
}

/**
 * Whether the person has talked to the agent in one room: one of its sessions
 * has attended it, which only a message to it there starts. Remembered on
 * this machine once seen, as `useGroupProgress` does.
 */
export function useTalkedIn({
  workspaceId,
  agentId,
  roomId,
}: {
  workspaceId: string;
  agentId: string;
  roomId: string | null;
}): boolean {
  const key = `switch-buddy:talked-in:${workspaceId}:${agentId}:${roomId ?? ''}`;
  const remembered = roomId !== null && readFlag(key);
  const query = useQuery({
    queryKey: ['buddy-talked-in', workspaceId, agentId, roomId],
    queryFn: async () =>
      (await rpc.workspaces.listAgentRooms({ workspaceId, agentId })).some(
        (room) => room.roomId === roomId && room.sessionAttended === true
      ),
    enabled: roomId !== null && !remembered,
    refetchInterval: (q) => (q.state.data ? false : SEEN_POLL_MS),
  });
  const talked = remembered || query.data === true;
  if (talked && !remembered) writeFlag(key);
  return talked;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Not remembered: read from the server again next time.
  }
}

/**
 * Where the agent is on this app: in a room there other than a direct chat
 * with the app, and whether one of its sessions has answered in one, which
 * only a message to it there starts.
 */
export function groupProgress(
  bridgeType: string,
  agentRooms: RemoteAgentRoom[],
  rooms: RemoteRoomSummary[]
): { inGroup: boolean; talking: boolean } {
  const onApp = new Set(
    rooms
      .filter((room) => room.bridgeType === bridgeType && room.channelType !== 'lobby')
      .map((room) => room.id)
  );
  const groups = agentRooms.filter((room) => !room.archived && onApp.has(room.roomId));
  return {
    inGroup: groups.length > 0,
    talking: groups.some((room) => room.sessionAttended === true),
  };
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
