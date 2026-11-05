import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { CronPicker } from '@renderer/lib/CronPicker';
import { parseCron } from '@renderer/lib/CronPicker/cron-utils';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { RemoteRoomSchedule } from '@shared/core/switch-servers/room-schedules';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';
import { scheduleTime } from './schedule-time';

export const RoomSchedulesSection = observer(function RoomSchedulesSection({
  workspaceId,
  room,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
}) {
  const cache = useQueryClient();
  const key = ['room-schedules', workspaceId, room.id];
  const schedules = useQuery({
    queryKey: key,
    queryFn: () => rpc.workspaces.listRoomSchedules({ workspaceId, roomId: room.id }),
    refetchInterval: 15000,
  });
  const agents = useWorkspaceAgents(workspaceId);
  const canManage = switchRoomsStore.roomPermissions(workspaceId, room).canManage;
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [body, setBody] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [recurring, setRecurring] = useState(false);
  const [cron, setCron] = useState('0 9 * * *');
  const [customCron, setCustomCron] = useState(false);
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function begin(row?: RemoteRoomSchedule) {
    setEditing(row?.id ?? null);
    setBody(row?.body ?? '');
    setTargets(
      (row?.agentIds ?? room.agentIds.slice(0, 1)).filter((id) => room.agentIds.includes(id))
    );
    setRecurring(Boolean(row?.cron));
    setCron(row?.cron ?? '0 9 * * *');
    setCustomCron(Boolean(row?.cron && !parseCron(row.cron)));
    setZone(row?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    const date = row?.nextRunAt ?? row?.lastRunAt;
    setWhen(localInput(date ?? new Date(Date.now() + 5 * 60_000).toISOString()));
    setError(null);
  }

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await cache.invalidateQueries({ queryKey: key });
      return true;
    } catch (cause) {
      setError(failureText(cause, 'Could not save this schedule.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (editing === undefined) return;
    const runAt = recurring ? null : new Date(when);
    if (runAt && !Number.isFinite(runAt.getTime())) {
      setError('Choose a valid date and time.');
      return;
    }
    const saved = await change(() =>
      rpc.workspaces.saveRoomSchedule({
        workspaceId,
        roomId: room.id,
        id: editing ?? undefined,
        input: {
          body,
          agentIds: targets,
          timezone: zone,
          cron: recurring ? cron : null,
          runAt: runAt?.toISOString() ?? null,
        },
      })
    );
    if (saved) setEditing(undefined);
  }

  return (
    <section id="room-settings-schedules" className="space-y-4 border-t border-border pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Schedules</h3>
          <p className="mt-1 text-xs text-foreground-muted">
            Ask agents to work at a set time. Switch sends the message even when Console is closed;
            an agent host must be running to answer.
          </p>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => begin()}>
            New schedule
          </Button>
        )}
      </div>
      {schedules.isPending && <p className="text-xs text-foreground-muted">Loading schedules…</p>}
      {schedules.isError && (
        <div role="alert" className="text-xs text-destructive">
          {failureText(schedules.error, 'Could not load schedules.')}{' '}
          <Button variant="ghost" size="sm" onClick={() => void schedules.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {schedules.data?.length === 0 && (
        <p className="text-xs text-foreground-muted">No schedules yet.</p>
      )}
      {schedules.data?.map((row) => (
        <div key={row.id} className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm whitespace-pre-wrap">{row.body}</p>
          <p className="text-xs text-foreground-muted">
            {row.agentIds.map((id) => agents.data?.find((a) => a.id === id)?.name ?? id).join(', ')}
          </p>
          <p className="text-xs text-foreground-muted">
            {row.paused
              ? 'Paused'
              : row.nextRunAt
                ? `Next: ${scheduleTime(row.nextRunAt, row.timezone)}`
                : 'Completed'}
            {row.cron ? ` · ${row.cron}` : ''}
          </p>
          {row.lastRunAt && (
            <p className="text-xs text-foreground-muted">
              Last occurrence: {new Date(row.lastRunAt).toLocaleString()}
            </p>
          )}
          {row.lastError && (
            <p role="alert" className="text-xs text-destructive">
              {row.lastError}
            </p>
          )}
          {canManage && (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => begin(row)}>
                Edit
              </Button>
              {(row.nextRunAt || row.cron) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void change(() =>
                      rpc.workspaces.pauseRoomSchedule({
                        workspaceId,
                        roomId: room.id,
                        id: row.id,
                        paused: !row.paused,
                      })
                    )
                  }
                >
                  {row.paused ? 'Resume' : 'Pause'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void change(() =>
                    rpc.workspaces.deleteRoomSchedule({ workspaceId, roomId: room.id, id: row.id })
                  )
                }
              >
                Delete
              </Button>
            </div>
          )}
        </div>
      ))}
      {editing !== undefined && canManage && (
        <form
          className="space-y-4 rounded-md border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block space-y-1 text-xs">
            Message
            <Textarea
              required
              maxLength={32000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs">Address agents</legend>
            {room.agentIds.length === 0 && (
              <p className="text-xs text-foreground-muted">Add an agent to this room first.</p>
            )}
            {room.agentIds.map((id) => (
              <label key={id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={targets.includes(id)}
                  onChange={(e) =>
                    setTargets(
                      e.target.checked ? [...targets, id] : targets.filter((x) => x !== id)
                    )
                  }
                />
                {agents.data?.find((a) => a.id === id)?.name ?? id}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
            />
            Repeat
          </label>
          {recurring ? (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={customCron}
                  onChange={(e) => setCustomCron(e.target.checked)}
                />
                Enter a cron rule
              </label>
              {customCron ? (
                <label className="block space-y-1 text-xs">
                  Five-field cron rule
                  <Input
                    required
                    maxLength={128}
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    placeholder="0 9 * * 1-5"
                  />
                  <span className="block text-foreground-muted">
                    For example, 0 9 * * 1-5 runs every weekday at 09:00 in the timezone below.
                  </span>
                </label>
              ) : (
                <CronPicker value={cron} onChange={setCron} />
              )}
            </div>
          ) : (
            <label className="block space-y-1 text-xs">
              Date and time on this computer
              <Input
                type="datetime-local"
                required
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </label>
          )}
          <label className="block space-y-1 text-xs">
            Timezone for recurring times and display
            <Input
              required
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Asia/Kolkata"
            />
          </label>
          <p className="text-xs text-foreground-muted">
            After server downtime, one missed occurrence is sent. Paused recurring runs are skipped.
            Resuming an overdue one-off sends it once. Daylight-saving gaps are skipped; repeated
            times run once.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || targets.length === 0}>
              {busy ? 'Saving…' : 'Save schedule'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
});

function localInput(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
