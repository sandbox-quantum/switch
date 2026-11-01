import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, Clock, Edit2, Loader2, Pause, Play, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { StatusBadge, type StatusTone } from '@renderer/lib/ui/status-badge';
import type { RemoteRoomDetail, RemoteRoomSchedule } from '@shared/core/switch-servers/switch-servers';
import { ScheduleDialog } from './schedule-dialog';

function roomSchedulesKey(workspaceId: string, roomId: string) {
  return ['room-schedules', workspaceId, roomId] as const;
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'paused':
      return 'warning';
    case 'completed':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export const RoomSchedulesSection = observer(function RoomSchedulesSection({
  workspaceId,
  room,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
}) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<RemoteRoomSchedule | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const canManage = Boolean(
    (room as { canDelete?: boolean }).canDelete || switchRoomsStore.canDeleteRoom(workspaceId, room),
  );
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const agentMap = new Map((remoteAgents.data ?? []).map((a) => [a.id, a.displayName || a.name]));

  const query = useQuery({
    queryKey: roomSchedulesKey(workspaceId, room.id),
    queryFn: async () => {
      try {
        return await rpc.workspaces.listRoomSchedules({ workspaceId, roomId: room.id });
      } catch {
        return [];
      }
    },
  });

  const schedules = query.data ?? [];

  const refreshSchedules = () => {
    void queryClient.invalidateQueries({ queryKey: roomSchedulesKey(workspaceId, room.id) });
  };

  const handleTogglePause = async (schedule: RemoteRoomSchedule) => {
    setActionInProgress(schedule.id);
    try {
      if (schedule.status === 'paused') {
        await rpc.workspaces.resumeRoomSchedule({
          workspaceId,
          roomId: room.id,
          scheduleId: schedule.id,
        });
      } else {
        await rpc.workspaces.pauseRoomSchedule({
          workspaceId,
          roomId: room.id,
          scheduleId: schedule.id,
        });
      }
      refreshSchedules();
    } catch (cause) {
      alert(failureText(cause, 'Could not change schedule state.'));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDelete = async (schedule: RemoteRoomSchedule) => {
    if (!confirm(`Are you sure you want to delete the schedule "${schedule.name}"?`)) {
      return;
    }
    setActionInProgress(schedule.id);
    try {
      await rpc.workspaces.deleteRoomSchedule({
        workspaceId,
        roomId: room.id,
        scheduleId: schedule.id,
      });
      refreshSchedules();
    } catch (cause) {
      alert(failureText(cause, 'Could not delete schedule.'));
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Scheduled Messages</h2>
          <span className="text-xs text-foreground-muted">
            {schedules.length === 1 ? '1 schedule' : `${schedules.length} schedules`}
          </span>
        </div>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditingSchedule(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-3.5" />
            New schedule
          </Button>
        )}
      </div>

      {query.isPending ? (
        <div className="flex items-center justify-center p-6 text-foreground-muted">
          <Loader2 className="size-4 animate-spin mr-2" />
          <span className="text-xs">Loading schedules…</span>
        </div>
      ) : query.isError ? (
        <div className="flex items-center justify-between rounded-lg border border-border p-3 text-xs">
          <span className="text-destructive">Could not load room schedules.</span>
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
            <RefreshCw className="size-3 mr-1" />
            Retry
          </Button>
        </div>
      ) : schedules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <Calendar className="mx-auto size-7 text-foreground-muted/60 mb-2" />
          <p className="text-sm font-medium text-foreground">No scheduled messages</p>
          <p className="text-xs text-foreground-muted mt-1 max-w-sm mx-auto">
            Set up recurring reminders, standup prompts, or one-off tasks to be automatically delivered to agents in this room.
          </p>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                setEditingSchedule(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-3.5 mr-1" />
              Create schedule
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {schedules.map((schedule) => {
            const isActing = actionInProgress === schedule.id;
            return (
              <div
                key={schedule.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3.5 shadow-xs transition-colors hover:border-border-hover"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-foreground truncate">
                        {schedule.name}
                      </span>
                      <StatusBadge tone={statusTone(schedule.status)}>
                        {schedule.status}
                      </StatusBadge>
                      {schedule.scheduleType === 'recurring' ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-muted font-mono">
                          {schedule.cronExpr}
                        </span>
                      ) : (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
                          one-off
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-foreground-muted mt-1">
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" />
                        {schedule.status === 'completed'
                          ? 'Completed'
                          : schedule.nextRunAt
                            ? `Next: ${formatDateTime(schedule.nextRunAt)} (${schedule.timezone})`
                            : 'No next run'}
                      </span>
                      {schedule.lastRunAt && (
                        <span>
                          Last run: {formatDateTime(schedule.lastRunAt)} (
                          {schedule.lastRunStatus ?? 'done'})
                        </span>
                      )}
                    </div>
                  </div>

                  {canManage && (
                    <div className="flex items-center gap-1 shrink-0">
                      {schedule.status !== 'completed' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isActing}
                          onClick={() => void handleTogglePause(schedule)}
                          title={schedule.status === 'paused' ? 'Resume schedule' : 'Pause schedule'}
                          aria-label={schedule.status === 'paused' ? 'Resume schedule' : 'Pause schedule'}
                        >
                          {schedule.status === 'paused' ? (
                            <Play className="size-3.5 text-foreground-success" />
                          ) : (
                            <Pause className="size-3.5 text-foreground-warning" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isActing}
                        onClick={() => {
                          setEditingSchedule(schedule);
                          setDialogOpen(true);
                        }}
                        title="Edit schedule"
                      >
                        <Edit2 className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isActing}
                        onClick={() => void handleDelete(schedule)}
                        className="text-destructive hover:text-destructive"
                        title="Delete schedule"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </div>

                <div className="rounded bg-muted/40 p-2 text-xs text-foreground/90 font-mono whitespace-pre-wrap break-words line-clamp-3">
                  {schedule.message}
                </div>

                {schedule.targetAgentIds && schedule.targetAgentIds.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-foreground-muted pt-0.5">
                    <Users className="size-3 text-foreground-muted/70" />
                    <span>Targeting:</span>
                    <div className="flex flex-wrap gap-1">
                      {schedule.targetAgentIds.map((agentId) => {
                        const name = agentMap.get(agentId) || agentId.slice(0, 8);
                        return (
                          <span
                            key={agentId}
                            className="rounded bg-muted px-1.5 py-0.2 text-[11px] text-foreground"
                          >
                            @{name}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dialogOpen && (
        <ScheduleDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          workspaceId={workspaceId}
          roomId={room.id}
          roomAgentIds={room.agentIds}
          schedule={editingSchedule}
          onSaved={refreshSchedules}
        />
      )}
    </section>
  );
});
