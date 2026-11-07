import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock, Pencil, Plus, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { CronPicker } from '@renderer/lib/CronPicker';
import { DEFAULT_CRON_STATE, parseCron, toCron } from '@renderer/lib/CronPicker/cron-utils';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type {
  RemoteAgentSummary,
  RoomSchedule,
  RoomScheduleInput,
  RoomScheduleType,
} from '@shared/core/switch-servers/switch-servers';
import { agentNameFor, useRoomDetail } from './room-participants';
import {
  absentAgentIds,
  blankDraft,
  browserTimezone,
  describeTiming,
  draftFromSchedule,
  draftToInput,
  formatRun,
  lastRunNote,
  type ScheduleDraft,
  scheduleStatus,
  timezoneChoices,
} from './room-schedules';
import { ConfirmIconButton } from './room-settings-sections';

const roomSchedulesKey = (workspaceId: string, roomId: string) =>
  ['room-schedules', workspaceId, roomId] as const;

const TYPE_OPTIONS = [
  { value: 'cron', label: 'Repeats' },
  { value: 'once', label: 'Once' },
] as const satisfies readonly { value: RoomScheduleType; label: string }[];

/**
 * A room's scheduled messages: what Switch posts to some of its agents, and
 * when, once or on a repeat. Everyone who can read the room sees them and
 * when each runs next; only its owner and workspace admins create, change,
 * pause and delete them, as on the server.
 */
export const RoomSchedulesPanel = observer(function RoomSchedulesPanel({
  roomId,
}: {
  roomId: string;
}) {
  const workspaceId = switchRoomsStore.roomWorkspaceId(roomId);
  const consoleChat = opensAsConsoleChat(roomId);
  const detail = useRoomDetail(workspaceId, roomId, !consoleChat);

  if (consoleChat) return <Centered>Group chats have no scheduled messages.</Centered>;
  if (workspaceId === null) return <Centered>This room’s workspace is still loading.</Centered>;
  if (detail.isPending) {
    return (
      <Centered>
        <Loader2 className="size-5 animate-spin" />
      </Centered>
    );
  }
  if (detail.isError) {
    return (
      <Centered>
        <span>{failureText(detail.error, 'Could not read this room.')}</span>
        <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
          <RefreshCw className="size-3" />
          Retry
        </Button>
      </Centered>
    );
  }
  const room = detail.data;
  const permissions = switchRoomsStore.roomPermissions(workspaceId, room);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-10 py-8">
        <Schedules
          key={roomId}
          workspaceId={workspaceId}
          roomId={roomId}
          roomAgentIds={room.agentIds}
          ownerName={room.ownerName}
          canManage={permissions.canManage}
        />
      </div>
    </div>
  );
});

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-sm text-foreground-muted">
      {children}
    </div>
  );
}

function Schedules({
  workspaceId,
  roomId,
  roomAgentIds,
  ownerName,
  canManage,
}: {
  workspaceId: string;
  roomId: string;
  roomAgentIds: string[];
  ownerName: string | null;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const key = roomSchedulesKey(workspaceId, roomId);
  const schedules = useQuery({
    queryKey: key,
    queryFn: () => rpc.workspaces.listRoomSchedules({ workspaceId, roomId }),
  });
  const agents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map<string, RemoteAgentSummary>(
    (agents.data ?? []).map((agent) => [agent.id, agent])
  );
  const agentName = (agentId: string) => agentNameFor(agentId, workspaceId, remoteById);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function store(next: (current: RoomSchedule[]) => RoomSchedule[]) {
    queryClient.setQueryData<RoomSchedule[]>(key, (current) => next(current ?? []));
  }
  const replace = (saved: RoomSchedule) =>
    store((current) => current.map((each) => (each.id === saved.id ? saved : each)));

  async function toggle(schedule: RoomSchedule, enabled: boolean) {
    setError(null);
    try {
      replace(
        await rpc.workspaces.updateRoomSchedule({
          workspaceId,
          roomId,
          scheduleId: schedule.id,
          changes: { enabled },
        })
      );
    } catch (cause) {
      setError(
        `Not ${enabled ? 'resumed' : 'paused'} — ${failureText(cause, 'Could not change the schedule.')}`
      );
    }
  }

  async function remove(schedule: RoomSchedule) {
    setError(null);
    try {
      await rpc.workspaces.deleteRoomSchedule({ workspaceId, roomId, scheduleId: schedule.id });
      store((current) => current.filter((each) => each.id !== schedule.id));
    } catch (cause) {
      setError(`Not deleted — ${failureText(cause, 'Could not delete the schedule.')}`);
    }
  }

  const list = schedules.data ?? [];
  return (
    <section aria-label="Scheduled messages" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Scheduled messages</h2>
          <span className="text-xs text-foreground-muted">{list.length}</span>
        </div>
        {canManage && !adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            New schedule
          </Button>
        )}
      </div>
      <p className="-mt-1 text-xs text-foreground-muted">
        Switch posts the message in this room, addressed to the agents you choose, so they receive
        it like any mention. It runs even when nobody has Console open. A run missed while the
        server was down is sent once, late, if it is under a day overdue, and skipped after that.
      </p>
      {!canManage && (
        <div className="flex items-center gap-2 rounded-md bg-background-secondary px-3 py-2 text-xs text-foreground-muted">
          <Lock className="size-3.5" />
          <span>
            Only {ownerName ?? 'the room’s owner'} or a workspace admin can change this room’s
            schedules.
          </span>
        </div>
      )}

      {adding && (
        <ScheduleForm
          roomAgentIds={roomAgentIds}
          agentName={agentName}
          initial={blankDraft(roomAgentIds.length === 1 ? roomAgentIds : [], browserTimezone())}
          submitLabel="Create schedule"
          onCancel={() => setAdding(false)}
          onSave={async (input) => {
            const created = await rpc.workspaces.createRoomSchedule({
              workspaceId,
              roomId,
              input,
            });
            store((current) => [...current, created]);
            setAdding(false);
          }}
        />
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}

      {schedules.isPending ? (
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
      ) : schedules.isError ? (
        <div className="flex items-center gap-3 text-sm text-foreground-muted">
          <span>{failureText(schedules.error, 'Could not read this room’s schedules.')}</span>
          <Button variant="outline" size="xs" onClick={() => void schedules.refetch()}>
            Retry
          </Button>
        </div>
      ) : list.length === 0 && !adding ? (
        <p className="text-sm text-foreground-muted">No scheduled messages in this room.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {list.map((schedule) =>
            editing === schedule.id ? (
              <div key={schedule.id} className="p-3">
                <ScheduleForm
                  roomAgentIds={roomAgentIds}
                  agentName={agentName}
                  initial={{
                    ...draftFromSchedule(schedule),
                    agentIds: schedule.agentIds.filter((id) => roomAgentIds.includes(id)),
                  }}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSave={async (input) => {
                    replace(
                      await rpc.workspaces.updateRoomSchedule({
                        workspaceId,
                        roomId,
                        scheduleId: schedule.id,
                        changes: input,
                      })
                    );
                    setEditing(null);
                  }}
                />
              </div>
            ) : (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                agentName={agentName}
                roomAgentIds={roomAgentIds}
                canManage={canManage}
                onEdit={() => setEditing(schedule.id)}
                onToggle={(enabled) => toggle(schedule, enabled)}
                onDelete={() => remove(schedule)}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}

const TONE_CLASS = {
  active: 'bg-foreground-success',
  paused: 'bg-foreground-warning',
  done: 'bg-[var(--fg-passive)]',
} as const;

function ScheduleRow({
  schedule,
  agentName,
  roomAgentIds,
  canManage,
  onEdit,
  onToggle,
  onDelete,
}: {
  schedule: RoomSchedule;
  agentName: (agentId: string) => string;
  roomAgentIds: string[];
  canManage: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const status = scheduleStatus(schedule);
  const absent = absentAgentIds(schedule, roomAgentIds);
  const note = lastRunNote(schedule);
  const finished = status.tone === 'done';
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className={cn('size-1.5 shrink-0 rounded-full', TONE_CLASS[status.tone])} />
          <span className="text-xs font-medium text-foreground-muted">{status.label}</span>
          <span className="truncate text-xs text-foreground-muted">
            {describeTiming(schedule)} · {schedule.timezone}
          </span>
        </div>
        <span className="line-clamp-3 text-sm whitespace-pre-wrap text-foreground">
          {schedule.message}
        </span>
        <span className="text-xs text-foreground-muted">
          To{' '}
          {schedule.agentIds.map((id, index) => (
            <span key={id}>
              {index > 0 && ', '}
              {agentName(id)}
              {absent.includes(id) && ' (left the room)'}
            </span>
          ))}
        </span>
        <span className="text-xs text-foreground-muted">
          {schedule.nextRunAt
            ? `Next run ${formatRun(schedule.nextRunAt, schedule.timezone)}`
            : finished
              ? 'Finished'
              : 'Not scheduled while paused'}
          {schedule.lastRunAt && ` · last ran ${formatRun(schedule.lastRunAt, schedule.timezone)}`}
        </span>
        {absent.length === schedule.agentIds.length && (
          <span className="text-xs text-foreground-warning">
            None of its agents is in this room any more, so nothing will be sent. Edit it to address
            someone who is.
          </span>
        )}
        {note !== null && <span className="text-xs text-foreground-warning">{note}</span>}
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          {!finished && (
            <Switch
              size="sm"
              aria-label={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
              title={schedule.enabled ? 'Pause' : 'Resume'}
              checked={schedule.enabled}
              onCheckedChange={(next) => void onToggle(next)}
            />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Edit schedule"
            title="Edit"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <ConfirmIconButton label="Delete schedule" onConfirm={onDelete} />
        </div>
      )}
    </div>
  );
}

/** A schedule's fields, for creating one or editing one. */
function ScheduleForm({
  roomAgentIds,
  agentName,
  initial,
  submitLabel,
  onCancel,
  onSave,
}: {
  roomAgentIds: string[];
  agentName: (agentId: string) => string;
  initial: ScheduleDraft;
  submitLabel: string;
  onCancel: () => void;
  onSave: (input: RoomScheduleInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [byHand, setByHand] = useState(parseCron(initial.cronExpression) === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<ScheduleDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    const request = draftToInput(draft);
    if (!request.ok) {
      setError(request.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(request.input);
    } catch (cause) {
      setError(failureText(cause, 'Could not save the schedule.'));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border p-3">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-foreground-muted">Send to</legend>
        {roomAgentIds.length === 0 ? (
          <p className="text-xs text-foreground-muted">
            This room has no agents. Add one to it first.
          </p>
        ) : (
          roomAgentIds.map((agentId) => (
            <label key={agentId} className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={draft.agentIds.includes(agentId)}
                onCheckedChange={(next) =>
                  change({
                    agentIds:
                      next === true
                        ? [...draft.agentIds, agentId]
                        : draft.agentIds.filter((id) => id !== agentId),
                  })
                }
              />
              {agentName(agentId)}
            </label>
          ))
        )}
      </fieldset>

      <Textarea
        rows={3}
        aria-label="Message"
        placeholder="What to send, e.g. Summarise the new issues since yesterday"
        value={draft.message}
        onChange={(e) => change({ message: e.target.value })}
      />

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={draft.type}
          onChange={(type) => change({ type })}
          options={TYPE_OPTIONS}
          ariaLabel="How often"
        />
        <TimezoneSelect value={draft.timezone} onChange={(timezone) => change({ timezone })} />
      </div>

      {draft.type === 'once' ? (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <span className="text-xs text-foreground-muted">Send at</span>
          <Input
            type="datetime-local"
            className="h-8 w-auto"
            aria-label="Date and time"
            value={draft.runAt}
            onChange={(e) => change({ runAt: e.target.value })}
          />
        </label>
      ) : byHand ? (
        <div className="flex flex-col gap-1.5">
          <Input
            className="h-8 font-mono"
            aria-label="Repeat rule"
            placeholder="0 9 * * 1-5"
            value={draft.cronExpression}
            onChange={(e) => change({ cronExpression: e.target.value })}
          />
          <p className="text-xs text-foreground-muted">
            Five fields: minute, hour, day of month, month, day of week. <code>0 9 * * 1-5</code> is
            09:00 on weekdays.{' '}
            {parseCron(draft.cronExpression) !== null && (
              <button type="button" className="underline" onClick={() => setByHand(false)}>
                Use the picker
              </button>
            )}
            {parseCron(draft.cronExpression) === null && (
              <button
                type="button"
                className="underline"
                onClick={() => {
                  change({ cronExpression: toCron(DEFAULT_CRON_STATE) });
                  setByHand(false);
                }}
              >
                Start over with the picker
              </button>
            )}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <CronPicker
            value={draft.cronExpression}
            onChange={(cronExpression) => change({ cronExpression })}
          />
          <button
            type="button"
            className="self-start text-xs text-foreground-muted underline"
            onClick={() => setByHand(true)}
          >
            Write the rule by hand
          </button>
        </div>
      )}

      {error !== null && <p className="text-xs text-destructive">Not saved — {error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}

function TimezoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (timezone: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label="Timezone" className="h-8 min-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} side="bottom" align="start">
        {timezoneChoices(value).map((zone) => (
          <SelectItem key={zone} value={zone}>
            {zone}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
