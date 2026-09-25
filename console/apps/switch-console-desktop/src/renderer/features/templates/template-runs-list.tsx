import { Boxes, ChevronRight, DoorOpen, Play, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TemplateRun } from '@main/core/switch-servers/gateway-client';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { StatusBadge } from '@renderer/lib/ui/status-badge';
import { cn } from '@renderer/utils/utils';
import { formatTimeAgo, isLiveRun, runAuthor, runLabel } from './template-runs';

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
export function useTemplateRuns(serverId: string): {
  runs: TemplateRun[];
  replace: (run: TemplateRun) => void;
} {
  const [runs, setRuns] = useState<TemplateRun[]>([]);
  // An answer that lands after the listing moved to another server belongs
  // to the old one and is dropped.
  const shownServer = useRef(serverId);
  shownServer.current = serverId;

  const load = useCallback(async () => {
    try {
      const list = await rpc.switchServers.listTemplateRuns({ serverId });
      if (shownServer.current === serverId) setRuns(list ?? []);
    } catch {
      // The runs are an addition to the recents; the section renders without them.
    }
  }, [serverId]);

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

function RunState({ run }: { run: TemplateRun }) {
  if (run.state === 'paused') return <StatusBadge tone="warning">Paused</StatusBadge>;
  if (run.state === 'stopped') return <StatusBadge tone="neutral">Stopped</StatusBadge>;
  if (!run.working) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
      Working
    </span>
  );
}

/**
 * One run in "Recently used": what it came from, who made its rooms and when
 * it last moved. Continue shows while it is paused and Stop while something
 * can still happen in it: an agent is working, or it is paused. Opening it
 * lists the rooms it made.
 */
export function TemplateRunRow({
  serverId,
  run,
  onChanged,
}: {
  serverId: string;
  run: TemplateRun;
  onChanged: (run: TemplateRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'continue' | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const Icon = run.rooms.length > 1 ? Boxes : DoorOpen;
  const rooms = run.rooms.length;
  const paused = run.state === 'paused';
  const canStop = run.canControl && (paused || (run.state === 'running' && run.working));

  const change = async (action: 'stop' | 'continue') => {
    setBusy(action);
    try {
      const params = { serverId, rootRoomId: run.rootRoomId };
      onChanged(
        action === 'stop'
          ? await rpc.switchServers.stopTemplateRun(params)
          : await rpc.switchServers.continueTemplateRun(params)
      );
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
      <div className="flex items-center transition-colors hover:bg-[var(--sel-soft)]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pl-3 text-left text-sm"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-foreground-muted transition-transform',
              open && 'rotate-90'
            )}
          />
          <Icon className="size-3.5 shrink-0 text-foreground-muted" />
          <span className="truncate">{runLabel(run)}</span>
          <span className="shrink-0 text-xs text-foreground-passive">by {runAuthor(run)}</span>
          <RunState run={run} />
        </button>
        <span className="flex shrink-0 items-center gap-3 pr-3 pl-3 text-xs text-foreground-passive">
          {run.canControl && paused && (
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy !== null}
              onClick={() => void change('continue')}
            >
              <Play className="size-3.5" />
              {busy === 'continue' ? 'Continuing…' : 'Continue'}
            </Button>
          )}
          {canStop && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={busy !== null}
              title="Agents can no longer create rooms in this run. The rooms stay."
              onClick={() => {
                // A stopped run cannot be started again, so the first click asks.
                if (confirmStop) void change('stop');
                else setConfirmStop(true);
              }}
              onBlur={() => setConfirmStop(false)}
            >
              <Square className="size-3.5" />
              {busy === 'stop' ? 'Stopping…' : confirmStop ? 'Click again to stop' : 'Stop'}
            </Button>
          )}
          <span>
            {rooms} {rooms === 1 ? 'room' : 'rooms'}
          </span>
          <span>{formatTimeAgo(Date.parse(run.lastActivityAt))}</span>
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
          {paused && run.reason && <p className="text-xs text-foreground-warning">{run.reason}</p>}
          {run.state === 'stopped' && (
            <p className="text-xs text-foreground-muted">
              {run.changedByName ? `Stopped by ${run.changedByName}.` : 'Stopped.'}
            </p>
          )}
          <ul className="flex flex-col">
            {run.rooms.map((room) => (
              <li key={room.id} className="flex items-center gap-2 py-0.5 text-sm">
                <DoorOpen className="size-3.5 shrink-0 text-foreground-muted" />
                {room.archived ? (
                  <span className="truncate text-foreground-muted">{room.name}</span>
                ) : (
                  <button
                    type="button"
                    className="cursor-pointer truncate text-left hover:underline"
                    onClick={() => void openRoom(room.id)}
                  >
                    {room.name}
                  </button>
                )}
                <span className="shrink-0 text-xs text-foreground-passive">
                  {formatTimeAgo(Date.parse(room.createdAt))}
                  {room.archived ? ' · archived' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
