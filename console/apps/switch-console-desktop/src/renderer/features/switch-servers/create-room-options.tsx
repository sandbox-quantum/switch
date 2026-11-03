import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ACCESS_LABELS } from '@renderer/features/switch-rooms/room-settings-sections';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import type { RemoteBridge, RoomAccess } from '@shared/core/switch-servers/switch-servers';
import type { RoomCreateOptions } from './room-create-request';

type ChannelChoice = 'public' | 'private' | 'existing';

const NO_GROUP = '__none__';
const ACCESS_ORDER: RoomAccess[] = ['public', 'read_only', 'private'];

/** The channel choice a set of options holds. */
function channelChoiceOf(options: RoomCreateOptions): ChannelChoice {
  if (options.channel.kind === 'existing') return 'existing';
  return options.channel.private ? 'private' : 'public';
}

/**
 * What a room on a messaging app can be made with beyond its name: its
 * channel, its group and who may see and change it. Shut until opened, so the
 * plain path stays short; each choice starts where the server would leave it
 * — a new public channel, no group, open to the workspace.
 *
 * Channel type and access stay separate: one is the platform's, the other
 * Switch's, and choosing a private channel does not change who may see the
 * room in Switch.
 */
export function CreateRoomOptions({
  workspaceId,
  bridge,
  value,
  onChange,
}: {
  workspaceId: string | null;
  bridge: RemoteBridge;
  value: RoomCreateOptions;
  onChange: (next: RoomCreateOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useQuery({
    queryKey: ['room-groups', workspaceId],
    queryFn: () => rpc.workspaces.listRoomGroups(workspaceId as string),
    enabled: workspaceId !== null && open,
  });
  // A connection shared between organisations cannot be pointed at a channel
  // by its id: the app says how to add one instead.
  const existingOffered = bridge.channelIdsRefused === null;
  const choice = channelChoiceOf(value);
  const groupName = (groups.data ?? []).find((group) => group.id === value.groupId)?.name;

  const channelOptions = [
    { value: 'public' as const, label: 'New public' },
    { value: 'private' as const, label: 'New private' },
    ...(existingOffered ? [{ value: 'existing' as const, label: 'Existing' }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <DisclosureRow open={open} title="More options" onToggle={() => setOpen(!open)} />
      {open && (
        <>
          <Field>
            <FieldLabel>Channel in {bridge.displayName}</FieldLabel>
            <SegmentedControl
              ariaLabel={`Channel in ${bridge.displayName}`}
              value={choice}
              options={channelOptions}
              onChange={(next) =>
                onChange({
                  ...value,
                  channel:
                    next === 'existing'
                      ? { kind: 'existing', externalChannelId: '' }
                      : { kind: 'new', private: next === 'private' },
                })
              }
            />
            {value.channel.kind === 'existing' ? (
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
                />
                <span className="text-xs text-foreground-muted">
                  The room uses this channel instead of making a new one.
                </span>
              </>
            ) : (
              <span className="text-xs text-foreground-muted">
                {choice === 'private'
                  ? `A private channel in ${bridge.displayName}: only people added to it can see it.`
                  : `A public channel in ${bridge.displayName}: anyone there can find and join it.`}
              </span>
            )}
          </Field>

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
              value={value.access ?? 'public'}
              onValueChange={(next) => onChange({ ...value, access: next as RoomAccess })}
            >
              <SelectTrigger className="w-full" aria-label="Who can see and change it">
                <SelectValue>{ACCESS_LABELS[value.access ?? 'public']}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ACCESS_ORDER.map((access) => (
                  <SelectItem key={access} value={access}>
                    {ACCESS_LABELS[access]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-foreground-muted">
              Who can see the room in Switch and change its settings, members and resources. It does
              not decide who can read or post in the channel.
            </span>
          </Field>
        </>
      )}
    </div>
  );
}
