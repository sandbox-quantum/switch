import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ACCESS_HELPERS,
  ACCESS_LABELS,
  ACCESS_ORDER,
} from '@renderer/features/switch-rooms/room-settings-sections';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { cn } from '@renderer/utils/utils';
import {
  type RemoteBridge,
  type RoomAccess,
  roomAccessForChannel,
} from '@shared/core/switch-servers/switch-servers';
import { channelChoiceCards, channelChoiceOf, channelIdProblem } from './room-channel-choices';
import type { RoomCreateOptions } from './room-create-request';

const NO_GROUP = '__none__';
const SAME_AS_CHANNEL = 'The same as the channel';

/**
 * Where a room on a messaging app lives: a new public channel (the default),
 * a new private one, or a channel already there. Always shown, as cards each
 * saying what the choice means on this platform, because Console cannot move
 * a room to another channel afterwards.
 */

export function RoomChannelField({
  bridge,
  value,
  onChange,
  linkedHere = null,
}: {
  bridge: RemoteBridge;
  value: RoomCreateOptions;
  onChange: (next: RoomCreateOptions) => void;
  /** Whether the signed-in person has a confirmed account linked on `bridge`;
   * null while unknown. */
  linkedHere?: boolean | null;
}) {
  const cards = channelChoiceCards(bridge, linkedHere);
  const choice = channelChoiceOf(value);
  return (
    <Field>
      <FieldLabel>Channel in {bridge.displayName}</FieldLabel>
      <div
        role="radiogroup"
        aria-label={`Channel in ${bridge.displayName}`}
        className={cn('grid gap-2', cards.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}
      >
        {cards.map((card) => (
          <button
            key={card.value}
            type="button"
            role="radio"
            aria-checked={choice === card.value}
            onClick={() =>
              onChange({
                ...value,
                channel:
                  card.value === 'existing'
                    ? { kind: 'existing', externalChannelId: '' }
                    : { kind: 'new', private: card.value === 'private' },
              })
            }
            className={cn(
              'flex flex-col justify-start gap-0.5 rounded-md border p-2.5 text-left',
              choice === card.value
                ? 'border-primary bg-background-tertiary-2'
                : 'border-border hover:bg-background-tertiary-2'
            )}
          >
            <span className="block text-sm font-medium text-foreground">{card.title}</span>
            <span className="block text-xs text-foreground-muted">{card.detail}</span>
          </button>
        ))}
      </div>
      {value.channel.kind === 'existing' && (
        <ExistingChannelId bridge={bridge} value={value} onChange={onChange} />
      )}
      <span className="text-xs text-foreground-muted">
        Console can’t move a room to another channel later.
      </span>
    </Field>
  );
}

function ExistingChannelId({
  bridge,
  value,
  onChange,
}: {
  bridge: RemoteBridge;
  value: RoomCreateOptions;
  onChange: (next: RoomCreateOptions) => void;
}) {
  if (value.channel.kind !== 'existing') return null;
  const problem = channelIdProblem(bridge.type, value.channel.externalChannelId);
  return (
    <>
      <Input
        aria-label="Channel id"
        placeholder="The channel’s id"
        value={value.channel.externalChannelId}
        onChange={(event) =>
          onChange({
            ...value,
            channel: { kind: 'existing', externalChannelId: event.target.value },
          })
        }
        aria-invalid={problem !== null}
      />
      {problem && <span className="text-xs text-destructive">{problem}</span>}
    </>
  );
}

/**
 * What a room can be made with that is easy to change afterwards, in its
 * Configuration tab: its group, and who may see it for a room with no channel
 * (a room on a messaging app takes that from its channel). Shut until
 * opened, its row saying what each is set to so the defaults are never a
 * surprise — no group, and open to the workspace for a room on a messaging
 * app or private to those taking part for a Switch Console chat.
 */
export function CreateRoomOptions({
  workspaceId,
  value,
  onChange,
  administersWorkspace,
  bridged,
}: {
  workspaceId: string | null;
  value: RoomCreateOptions;
  onChange: (next: RoomCreateOptions) => void;
  /**
   * Whether the viewer administers the workspace. Only they put a room in a
   * group, since a group can decide who may address an agent; for anyone
   * else the room is made with none and the group is not offered.
   */
  administersWorkspace: boolean;
  /**
   * Whether the room is on a messaging app. A Switch Console chat is made
   * private unless asked otherwise, and has no channel for access to differ from.
   */
  bridged: boolean;
}) {
  const [open, setOpen] = useState(false);
  const groups = useQuery({
    // The key every view reads the groups under, so they go stale and refresh together.
    queryKey: ['remote-room-groups', workspaceId],
    queryFn: () => rpc.workspaces.listRoomGroups(workspaceId as string),
    enabled: workspaceId !== null && administersWorkspace,
  });
  // The group is named once the list has it; until then (or if it could not be
  // read) the room is still filed under it, so say so rather than "none".
  const groupName =
    value.groupId === null
      ? null
      : ((groups.data ?? []).find((group) => group.id === value.groupId)?.name ??
        (groups.isError ? 'unknown (the groups could not be read)' : 'loading…'));
  // Until someone picks, a bridged room takes it from its channel (for an
  // existing channel only the server knows: it asks the platform), and a room
  // on no app is private.
  const access = bridged ? roomAccessForChannel(value.channel) : (value.access ?? 'private');
  const accessLabel = access === null ? SAME_AS_CHANNEL : ACCESS_LABELS[access];

  // A room on a messaging app takes its access from its channel: the channel
  // choice is the access choice, and an existing channel's is the platform's.
  // Its owner or an admin can change it later in the room's settings. Only a
  // room with no channel is asked.
  if (bridged && !administersWorkspace) {
    return (
      <span className="text-xs text-foreground-muted">
        Access: {accessLabel}. Changed later in the room’s Configuration.
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <DisclosureRow
        open={open}
        title="More options"
        summary={
          administersWorkspace ? `Group: ${groupName ?? 'none'} · ${accessLabel}` : accessLabel
        }
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <>
          {administersWorkspace && (
            <Field>
              <FieldLabel>Group</FieldLabel>
              <Select
                value={value.groupId ?? NO_GROUP}
                onValueChange={(next) =>
                  onChange({ ...value, groupId: next === NO_GROUP ? null : (next as string) })
                }
              >
                <SelectTrigger className="w-full" aria-label="Group">
                  <SelectValue>{groupName ?? 'No group'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GROUP}>No group</SelectItem>
                  {(groups.data ?? []).map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {groups.isError && (
                <span className="text-xs text-destructive">
                  {failureText(groups.error, 'Could not list the groups.')}
                </span>
              )}
            </Field>
          )}

          {!bridged && (
            <Field>
              <FieldLabel>Access</FieldLabel>
              <Select
                value={access ?? ''}
                onValueChange={(next) => onChange({ ...value, access: next as RoomAccess })}
              >
                <SelectTrigger className="w-full" aria-label="Access">
                  <SelectValue>{accessLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_ORDER.map((each) => (
                    <SelectItem key={each} value={each}>
                      {ACCESS_LABELS[each]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-foreground-muted">
                {access !== null && ACCESS_HELPERS[access]}
              </span>
            </Field>
          )}
        </>
      )}
    </div>
  );
}
