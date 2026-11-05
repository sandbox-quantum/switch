import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CalendarClock, Loader2, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useId, useState } from 'react';
import { CronPicker } from '@renderer/lib/CronPicker';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import type {
  RemoteRoomDetail,
  RemoteRoomSchedule,
  RoomScheduleTiming,
} from '@shared/core/switch-servers/switch-servers';
import { agentNameFor } from './room-agent-names';
import {
  describeTiming,
  nextRunLabel,
  timingFromForm,
  toLocalDateTimeInput,
} from './room-schedule-labels';

function roomSchedulesKey(workspaceId: string, roomId: string) {
  return ['remote-room-schedules', workspaceId, roomId] as const;
}

function formatTime(iso: string): string {
  return format(new Date(iso), 'EEE MMM d yyyy, HH:mm');
}

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TIMEZONES = Intl.supportedValuesOf('timeZone');

/**
 * Messages Switch posts in this room at a set time, to some of its agents:
 * once, or on a repeating rule. The server keeps and fires them, so they go
 * out whether or not this app is open.
 *
 * Whoever last sets a schedule's text or agents is who it speaks for; each
 * agent judges the message as coming from them.
 */
export const RoomSchedulesSection = observer(function RoomSchedulesSection({
  workspaceId,
  room,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: roomSchedulesKey(workspaceId, room.id),
    queryFn: () => rpc.workspaces.listRoomSchedules({ workspaceId, roomId: room.id }),
  });
  // Which schedule the editor is open for: a new one, an existing one by id, or none.
  const [editing, setEditing] = useState<'new' | string | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: roomSchedulesKey(workspaceId, room.id) });
  }

  const noAgents = room.agentIds.length === 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Schedules</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={noAgents || editing === 'new'}
          title={noAgents ? 'Add an agent to this room to schedule a message to it.' : undefined}
          onClick={() => setEditing('new')}
        >
          <Plus className="size-3.5" />
          New schedule
        </Button>
      </div>

      {editing === 'new' && (
        <ScheduleEditor
          workspaceId={workspaceId}
          room={room}
          schedule={null}
          onDone={async (saved) => {
            setEditing(null);
            if (saved) await refresh();
          }}
        />
      )}

      {query.isPending ? (
        <p className="flex items-center gap-2 text-sm text-foreground-muted">
          <Loader2 className="size-3.5 animate-spin" />
          Loading schedules…
        </p>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          {describeFailure(query.error, 'Could not read this room’s schedules.').headline}
        </p>
      ) : query.data.length === 0 ? (
        editing !== 'new' && (
          <p className="text-sm text-foreground-muted">
            No scheduled messages. A schedule posts a message to agents in this room at a set time,
            once or on a repeat.
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2.5">
          {query.data.map((schedule) =>
            editing === schedule.id ? (
              <ScheduleEditor
                key={schedule.id}
                workspaceId={workspaceId}
                room={room}
                schedule={schedule}
                onDone={async (saved) => {
                  setEditing(null);
                  if (saved) await refresh();
                }}
              />
            ) : (
              <ScheduleCard
                key={schedule.id}
                workspaceId={workspaceId}
                schedule={schedule}
                onEdit={() => setEditing(schedule.id)}
                onChanged={refresh}
              />
            )
          )}
        </div>
      )}
    </section>
  );
});

/** One schedule: what it says, to whom, when, and the actions on it. */
const ScheduleCard = observer(function ScheduleCard({
  workspaceId,
  schedule,
  onEdit,
  onChanged,
}: {
  workspaceId: string;
  schedule: RemoteRoomSchedule;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map((remoteAgents.data ?? []).map((a) => [a.id, a]));
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(run: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await onChanged();
    } catch (cause) {
      setError(failureText(cause, failure));
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  const agents = schedule.agentIds.map((id) => `@${agentNameFor(id, workspaceId, remoteById)}`);
  const done = schedule.nextRunAt === null && !schedule.paused;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <CalendarClock className="size-3.5 shrink-0 text-foreground-muted" />
            {describeTiming(schedule, formatTime)}
          </span>
          <span className="line-clamp-2 text-sm text-foreground">
            <span className="text-foreground-muted">{agents.join(' ')}</span> {schedule.body}
          </span>
          <span className="text-xs text-foreground-muted">
            {nextRunLabel(schedule, formatTime)} · set by {schedule.authorName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!done && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    rpc.workspaces.updateRoomSchedule({
                      workspaceId,
                      roomId: schedule.roomId,
                      scheduleId: schedule.id,
                      changes: { paused: !schedule.paused },
                    }),
                  schedule.paused ? 'Could not resume it.' : 'Could not pause it.'
                )
              }
            >
              {schedule.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {schedule.paused ? 'Resume' : 'Pause'}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={onEdit}>
            <Pencil className="size-3.5" />
            Edit
          </Button>
          <Button
            variant={confirmingDelete ? 'destructive' : 'outline'}
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!confirmingDelete) {
                setConfirmingDelete(true);
                return;
              }
              void act(
                () =>
                  rpc.workspaces.deleteRoomSchedule({
                    workspaceId,
                    roomId: schedule.roomId,
                    scheduleId: schedule.id,
                  }),
                'Could not delete it.'
              );
            }}
          >
            <Trash2 className="size-3.5" />
            {confirmingDelete ? 'Delete?' : 'Delete'}
          </Button>
        </div>
      </div>
      {schedule.lastError !== null && (
        <p className="text-xs text-destructive">{schedule.lastError}</p>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
});

function sameTiming(a: RoomScheduleTiming, b: RemoteRoomSchedule): boolean {
  return a.cron === b.cron && a.runAt === b.runAt && a.timezone === b.timezone;
}

/**
 * The form for a new schedule or an existing one. Only agents in the room can
 * be chosen, since only they would hear it; the server checks the same.
 */
const ScheduleEditor = observer(function ScheduleEditor({
  workspaceId,
  room,
  schedule,
  onDone,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  schedule: RemoteRoomSchedule | null;
  onDone: (saved: boolean) => Promise<void>;
}) {
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map((remoteAgents.data ?? []).map((a) => [a.id, a]));
  const timezoneListId = useId();
  const [body, setBody] = useState(schedule?.body ?? '');
  // An agent that has left the room since is not offered, and not kept.
  const [agentIds, setAgentIds] = useState<Set<string>>(
    new Set(
      schedule !== null
        ? schedule.agentIds.filter((id) => room.agentIds.includes(id))
        : room.agentIds.length === 1
          ? room.agentIds
          : []
    )
  );
  const [repeat, setRepeat] = useState(schedule === null || schedule.cron !== null);
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * 1');
  const [localDateTime, setLocalDateTime] = useState(
    schedule?.runAt ? toLocalDateTimeInput(schedule.runAt) : ''
  );
  const [timezone, setTimezone] = useState(schedule?.timezone ?? LOCAL_TIMEZONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const parsed = timingFromForm(
      // A one-off is typed on this computer's clock, so it carries this
      // computer's timezone; only a rule is read in the one chosen.
      { repeat, cron, localDateTime, timezone: repeat ? timezone : LOCAL_TIMEZONE },
      new Date()
    );
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    if (body.trim() === '') {
      setError('Write the message to send.');
      return;
    }
    if (agentIds.size === 0) {
      setError('Choose at least one agent.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (schedule === null) {
        await rpc.workspaces.createRoomSchedule({
          workspaceId,
          roomId: room.id,
          draft: { ...parsed.timing, agentIds: [...agentIds], body },
        });
      } else {
        await rpc.workspaces.updateRoomSchedule({
          workspaceId,
          roomId: room.id,
          scheduleId: schedule.id,
          changes: {
            agentIds: [...agentIds],
            body,
            // Sent only when changed: resending a one-off that has fired
            // would be refused as being in the past.
            timing: sameTiming(parsed.timing, schedule) ? undefined : parsed.timing,
          },
        });
      }
      await onDone(true);
    } catch (cause) {
      setError(failureText(cause, 'Could not save the schedule.'));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-[10px] border border-border px-3.5 py-3.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-foreground-muted">Agents</span>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {room.agentIds.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={agentIds.has(id)}
                onCheckedChange={(checked) => {
                  const next = new Set(agentIds);
                  if (checked) next.add(id);
                  else next.delete(id);
                  setAgentIds(next);
                }}
              />
              {agentNameFor(id, workspaceId, remoteById)}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-foreground-muted">Message</span>
        <Textarea
          rows={3}
          placeholder="e.g. Summarise the issues opened since yesterday"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Switch checked={repeat} onCheckedChange={setRepeat} />
          Repeat
        </label>
        {repeat ? (
          <div className="flex flex-col gap-2">
            <CronPicker value={cron} onChange={setCron} />
            <div className="flex items-center gap-2">
              <span className="text-xs text-foreground-muted">Timezone</span>
              <Input
                className="h-8 max-w-64"
                list={timezoneListId}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
              <datalist id={timezoneListId}>
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </div>
          </div>
        ) : (
          <Input
            type="datetime-local"
            className="h-8 max-w-64"
            value={localDateTime}
            onChange={(e) => setLocalDateTime(e.target.value)}
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        {error !== null && <span className="text-xs text-destructive">{error}</span>}
        <Button variant="outline" size="sm" disabled={saving} onClick={() => void onDone(false)}>
          Cancel
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : schedule === null ? 'Schedule' : 'Save'}
        </Button>
      </div>
    </div>
  );
});
