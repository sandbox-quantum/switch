import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ACCESS_LABELS } from '@renderer/features/switch-rooms/room-settings-sections';
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
import type { RemoteBridge, RoomAccess } from '@shared/core/switch-servers/switch-servers';
import { type ChannelChoice, channelChoiceCards, channelIdProblem } from './room-channel-choices';
import type { RoomCreateOptions } from './room-create-request';

const NO_GROUP = '__none__';
const ACCESS_ORDER: RoomAccess[] = ['public', 'read_only', 'private'];

/** The channel choice a set of options holds. */
function channelChoiceOf(options: RoomCreateOptions): ChannelChoice {
  if (options.channel.kind === 'existing') return 'existing';
  return options.channel.private ? 'private' : 'public';
}

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
}: {
  bridge: RemoteBridge;
  value: RoomCreateOptions;
  onChange: (next: RoomCreateOptions) => void;
}) {
  const cards = channelChoiceCards(bridge);
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
              'space-y-0.5 rounded-md border p-2.5 text-left',
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
 * Configuration tab: its group and who may see and change it. Shut until
 * opened, its row saying what each is set to so the defaults are never a
 * surprise — no group, open to the workspace.
 */
export function CreateRoomOptions({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string | null;
  value: RoomCreateOptions;
  onChange: (next: RoomCreateOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useQuery({
    queryKey: ['room-groups', workspaceId],
    queryFn: () => rpc.workspaces.listRoomGroups(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const groupName = (groups.data ?? []).find((group) => group.id === value.groupId)?.name;
  const access = value.access ?? 'public';

  return (
    <div className="flex flex-col gap-4">
      <DisclosureRow
        open={open}
        title="More options"
        summary={`Group: ${groupName ?? 'none'} · ${ACCESS_LABELS[access]}`}
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <>
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

          <Field>
            <FieldLabel>Who can see and change it</FieldLabel>
            <Select
              value={access}
              onValueChange={(next) => onChange({ ...value, access: next as RoomAccess })}
            >
              <SelectTrigger className="w-full" aria-label="Who can see and change it">
                <SelectValue>{ACCESS_LABELS[access]}</SelectValue>
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
              Who can see the room in Switch and change its settings, members and resources. It does
              not decide who can read or post in the channel. Both can be changed later in the
              room’s Configuration.
            </span>
          </Field>
        </>
      )}
    </div>
  );
}
