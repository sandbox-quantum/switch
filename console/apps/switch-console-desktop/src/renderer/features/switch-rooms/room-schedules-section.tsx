import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { RoomPermissions } from '@renderer/features/switch-servers/room-permissions';
import { CronPicker } from '@renderer/lib/CronPicker/CronPicker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Textarea } from '@renderer/lib/ui/textarea';
import type {
  RemoteRoomDetail,
  RemoteRoomSchedule,
  RoomScheduleDraft,
} from '@shared/core/switch-servers/switch-servers';
import {
  describeTiming,
  knownTimezone,
  momentIn,
  scheduleState,
  wallTimeIn,
} from './room-schedule-labels';

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DEFAULT_CRON = '0 9 * * *';

function schedulesKey(workspaceId: string, roomId: string) {
  return ['room-schedules', workspaceId, roomId] as const;
}

/**
 * The room's schedules: messages Switch posts to agents here on a timer, on
 * behalf of whoever last set them. Shown to anyone who can see the room; a
 * change someone may not make is refused by the server, and the refusal is
 * shown here in its words.
 */
export function SchedulesSection({
  workspaceId,
  room,
  permissions,
}: {
  workspaceId: string;
  room: Pick<RemoteRoomDetail, 'id' | 'agentIds' | 'viewerIsRoomAdmin'>;
  permissions: Pick<RoomPermissions, 'canManage'>;
}) {
  // The owner, a room admin or a workspace admin; a server that predates
  // room admins took managing the room.
  const canChange = permissions.canManage || room.viewerIsRoomAdmin;
  const queryClient = useQueryClient();
  const key = schedulesKey(workspaceId, room.id);
  const schedules = useQuery({
    queryKey: key,
    queryFn: () => rpc.workspaces.listRoomSchedules({ workspaceId, roomId: room.id }),
  });
  const agents = useWorkspaceAgents(workspaceId);
  const names = new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(change: () => Promise<unknown>, fallback: string) {
    setError(null);
    try {
      await change();
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(failureText(cause, fallback));
    }
  }

  function form(schedule: RemoteRoomSchedule | null) {
    return (
      <ScheduleForm
        agentIds={room.agentIds}
        names={names}
        schedule={schedule}
        onCancel={() => setEditing(null)}
        onSave={(draft) =>
          act(async () => {
            await (schedule
              ? rpc.workspaces.updateRoomSchedule({
                  workspaceId,
                  roomId: room.id,
                  scheduleId: schedule.id,
                  draft,
                })
              : rpc.workspaces.createRoomSchedule({ workspaceId, roomId: room.id, draft }));
            setEditing(null);
          }, 'Could not save the schedule.')
        }
      />
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-foreground">Schedules</h2>
          <p className="text-xs text-foreground-muted">
            Messages Switch posts to agents here on a timer, on behalf of whoever set them up.
            {!canChange &&
              ' Only the room’s owner, a room admin or a workspace admin can change them.'}
          </p>
        </div>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            disabled={room.agentIds.length === 0 || editing === 'new'}
            onClick={() => setEditing('new')}
          >
            <Plus className="size-3.5" />
            Add schedule
          </Button>
        )}
      </div>

      {editing === 'new' && form(null)}

      {schedules.isError ? (
        <p className="text-sm text-red-500">
          {failureText(schedules.error, 'Could not read this room’s schedules.')}
        </p>
      ) : (schedules.data ?? []).length === 0 && editing !== 'new' ? (
        <p className="text-sm text-foreground-muted">
          {room.agentIds.length === 0
            ? 'Add an agent to this room to schedule messages to it.'
            : 'No schedules yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(schedules.data ?? []).map((schedule) =>
            editing === schedule.id ? (
              <li key={schedule.id}>{form(schedule)}</li>
            ) : (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                names={names}
                canChange={canChange}
                onEdit={() => setEditing(schedule.id)}
                onPause={(paused) =>
                  act(
                    () =>
                      rpc.workspaces.setRoomSchedulePaused({
                        workspaceId,
                        roomId: room.id,
                        scheduleId: schedule.id,
                        paused,
                      }),
                    paused ? 'Could not pause the schedule.' : 'Could not resume the schedule.'
                  )
                }
                onDelete={() =>
                  act(
                    () =>
                      rpc.workspaces.deleteRoomSchedule({
                        workspaceId,
                        roomId: room.id,
                        scheduleId: schedule.id,
                      }),
                    'Could not delete the schedule.'
                  )
                }
              />
            )
          )}
        </ul>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
    </section>
  );
}

function ScheduleRow({
  schedule,
  names,
  canChange,
  onEdit,
  onPause,
  onDelete,
}: {
  schedule: RemoteRoomSchedule;
  names: Map<string, string>;
  canChange: boolean;
  onEdit: () => void;
  onPause: (paused: boolean) => void;
  onDelete: () => void;
}) {
  const state = scheduleState(schedule);
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm text-foreground">{schedule.text}</p>
        <p className="text-xs text-foreground-muted">
          {schedule.authorAgentId !== null &&
            `Set up by @${names.get(schedule.authorAgentId) ?? schedule.authorAgentId} · `}
          To {schedule.agentIds.map((id) => `@${names.get(id) ?? id}`).join(', ')} ·{' '}
          {describeTiming(schedule)}
          {schedule.runAt !== null && (
            <>
              {' '}
              <AbsoluteTime value={schedule.runAt} includeYear />
            </>
          )}
        </p>
        <p className="text-xs text-foreground-muted">
          {state === 'paused' ? (
            'Paused'
          ) : state === 'sent' ? (
            'Sent'
          ) : (
            <>
              Next: <AbsoluteTime value={schedule.nextRunAt!} includeYear />
            </>
          )}
        </p>
      </div>
      {canChange && (
        <div className="flex shrink-0 items-center gap-1">
          {state !== 'sent' && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={schedule.paused ? 'Resume' : 'Pause'}
              onClick={() => onPause(!schedule.paused)}
            >
              {schedule.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-label="Edit" onClick={onEdit}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" aria-label="Delete" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}
    </li>
  );
}

type Timing = 'repeat' | 'once';

function ScheduleForm({
  agentIds,
  names,
  schedule,
  onSave,
  onCancel,
}: {
  agentIds: string[];
  names: Map<string, string>;
  schedule: RemoteRoomSchedule | null;
  onSave: (draft: RoomScheduleDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(
    schedule?.agentIds ?? (agentIds.length === 1 ? agentIds : [])
  );
  const [text, setText] = useState(schedule?.text ?? '');
  const [timing, setTiming] = useState<Timing>(schedule?.runAt ? 'once' : 'repeat');
  const [cron, setCron] = useState(schedule?.cron ?? DEFAULT_CRON);
  const [runAt, setRunAt] = useState(
    schedule?.runAt ? wallTimeIn(schedule.runAt, schedule.timezone) : ''
  );
  const [timezone, setTimezone] = useState(schedule?.timezone ?? LOCAL_TIMEZONE);
  const [saving, setSaving] = useState(false);

  const ready =
    chosen.length > 0 &&
    text.trim() !== '' &&
    knownTimezone(timezone) &&
    (timing === 'repeat' || runAt !== '') &&
    !saving;

  async function save() {
    setSaving(true);
    try {
      await onSave({
        agentIds: chosen,
        text: text.trim(),
        cron: timing === 'repeat' ? cron : null,
        runAt: timing === 'once' ? momentIn(runAt, timezone) : null,
        timezone,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {agentIds.map((id) => (
          <label key={id} className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={chosen.includes(id)}
              onCheckedChange={(on) =>
                setChosen((now) => (on ? [...now, id] : now.filter((other) => other !== id)))
              }
            />
            @{names.get(id) ?? id}
          </label>
        ))}
      </div>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="What to ask, e.g. Summarise the issues opened since yesterday."
        rows={2}
      />
      <SegmentedControl<Timing>
        value={timing}
        onChange={setTiming}
        ariaLabel="When it is sent"
        options={[
          { value: 'repeat', label: 'Repeats' },
          { value: 'once', label: 'Once' },
        ]}
      />
      {timing === 'repeat' ? (
        <CronPicker value={cron} onChange={setCron} />
      ) : (
        <Input
          type="datetime-local"
          value={runAt}
          onChange={(event) => setRunAt(event.target.value)}
          aria-label={`When to send it, on the clocks of ${timezone}`}
        />
      )}
      <Input
        value={timezone}
        onChange={(event) => setTimezone(event.target.value)}
        aria-label="Timezone"
        placeholder="Timezone, e.g. Europe/London"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!ready} onClick={() => void save()}>
          {schedule ? 'Save' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
