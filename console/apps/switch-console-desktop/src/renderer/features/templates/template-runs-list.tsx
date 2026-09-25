import { Boxes, ChevronRight, DoorOpen, Play, Repeat, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { TemplateRun } from '@main/core/switch-servers/gateway-client';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { StatusBadge } from '@renderer/lib/ui/status-badge';
import { cn } from '@renderer/utils/utils';
import { stopRunSessions } from './stop-run-sessions';
import { formatTimeAgo, isLiveRun, runAuthor, runLabel, runRoomTree } from './template-runs';

/** How often shown runs are asked for again while one of them can still change. */
const LIVE_RUN_POLL_MS = 15_000;

/**
 * The runs the server records for this workspace, loaded when the listing
 * opens and again when the window regains focus, and polled while any of
 * them is running or paused.
 *
 * Quiet on failure: an older server without runs answers 404 and the list
 * stays empty, and a failed refresh keeps what was already shown.
 */
export function useTemplateRuns(workspaceId: string | null): {
  runs: TemplateRun[];
  replace: (run: TemplateRun) => void;
} {
  const [runs, setRuns] = useState<TemplateRun[]>([]);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    try {
      const list = await rpc.workspaces.listTemplateRuns({ workspaceId });
      setRuns(list ?? []);
    } catch {
      // The runs are an addition to the recents; the section renders without them.
    }
  }, [workspaceId]);

  useEffect(() => {
    setRuns([]);
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const live = runs.some(isLiveRun);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void load();
    }, LIVE_RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const replace = useCallback(
    (run: TemplateRun) =>
      setRuns((prev) => prev.map((r) => (r.rootRoomId === run.rootRoomId ? run : r))),
    []
  );

  return { runs, replace };
}

function RunStateChip({ run }: { run: TemplateRun }) {
  if (run.state === 'paused') return <StatusBadge tone="warning">Paused</StatusBadge>;
  if (run.state === 'stopped') return <StatusBadge tone="neutral">Stopped</StatusBadge>;
  return null;
}

/**
 * One run in "Recently used": what it came from, who made its rooms and when
 * it last moved. Opening it shows the rooms it made as a tree, and gives its
 * owner Continue and Stop.
 */
export function TemplateRunRow({
  workspaceId,
  run,
  onChanged,
}: {
  workspaceId: string;
  run: TemplateRun;
  onChanged: (run: TemplateRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'continue' | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const Icon = run.rooms.length > 1 ? Boxes : DoorOpen;
  const rooms = run.rooms.length;

  const change = async (action: 'stop' | 'continue') => {
    setBusy(action);
    try {
      const params = { workspaceId, rootRoomId: run.rootRoomId };
      const updated =
        action === 'stop'
          ? await rpc.workspaces.stopTemplateRun(params)
          : await rpc.workspaces.continueTemplateRun(params);
      onChanged(updated);
      if (action === 'stop') {
        const local = await stopRunSessions(updated.rooms.map((r) => r.id));
        if (local.failed > 0) {
          toast({
            title: `"${runLabel(run)}" is stopped`,
            description: `${local.failed} of this Console's sessions in its rooms did not confirm they stopped. Check them from the sidebar.`,
            variant: 'destructive',
          });
        }
      }
    } catch (error) {
      toast({
        title:
          action === 'stop'
            ? `Could not stop "${runLabel(run)}"`
            : `Could not continue "${runLabel(run)}"`,
        description: failureText(error, 'The server did not accept the change.'),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
      setConfirmStop(false);
    }
  };

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--sel-soft)]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-foreground-muted transition-transform',
              open && 'rotate-90'
            )}
          />
          <Icon className="size-3.5 shrink-0 text-foreground-muted" />
          <span className="truncate">{runLabel(run)}</span>
          <span className="shrink-0 text-xs text-foreground-passive">by {runAuthor(run)}</span>
          <RunStateChip run={run} />
        </span>
        <span className="flex shrink-0 items-center gap-3 text-xs text-foreground-passive">
          <span>
            {rooms} {rooms === 1 ? 'room' : 'rooms'}
          </span>
          <span>{formatTimeAgo(Date.parse(run.lastActivityAt))}</span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {run.state === 'paused' && run.reason && (
            <p className="text-xs text-foreground-warning">{run.reason}</p>
          )}
          {run.state === 'stopped' && (
            <p className="text-xs text-foreground-muted">
              {run.changedByName ? `Stopped by ${run.changedByName}.` : 'Stopped.'}
              {run.reason ? ` ${run.reason}` : ''}
            </p>
          )}
          <ul className="flex flex-col">
            {runRoomTree(run.rooms).map(({ room, depth }) => {
              const repeated = run.state === 'paused' && run.pausedRepeatOf === room.id;
              return (
                <li
                  key={room.id}
                  className="flex items-center gap-2 py-0.5 text-sm"
                  style={{ paddingLeft: depth * 16 }}
                >
                  <DoorOpen className="size-3.5 shrink-0 text-foreground-muted" />
                  {room.archived ? (
                    <span className="truncate text-foreground-muted" title="Archived">
                      {room.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cursor-pointer truncate text-left hover:underline"
                      onClick={() => void openRoom(room.id)}
                    >
                      {room.name}
                    </button>
                  )}
                  {repeated && (
                    <StatusBadge tone="warning">
                      <span className="inline-flex items-center gap-1">
                        <Repeat className="size-3" />
                        Asked to repeat
                      </span>
                    </StatusBadge>
                  )}
                  <span className="shrink-0 text-xs text-foreground-passive">
                    {room.createdByAgentName ?? (room.createdByAgentId ? 'an agent' : 'a person')}
                    {' · '}
                    {formatTimeAgo(Date.parse(room.createdAt))}
                    {room.archived ? ' · archived' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          {run.canControl && isLiveRun(run) && (
            <div className="flex items-center gap-2">
              {run.state === 'paused' && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void change('continue')}
                >
                  <Play className="size-3.5" />
                  {busy === 'continue' ? 'Continuing…' : 'Continue'}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                title="Agents can no longer create rooms in this run, and this Console's sessions in its rooms stop. The rooms stay."
                onClick={() => {
                  // The first click asks for confirmation, the second stops.
                  // A stopped run cannot be started again.
                  if (confirmStop) void change('stop');
                  else setConfirmStop(true);
                }}
                onBlur={() => setConfirmStop(false)}
              >
                <Square className="size-3.5" />
                {busy === 'stop' ? 'Stopping…' : confirmStop ? 'Click again to stop' : 'Stop run'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
