import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import type { RemoteRoomDetail, RoomAutoRoute } from '@shared/core/switch-servers/switch-servers';

/** The value the triage picker uses for "nobody": Select values are strings. */
const NO_TRIAGE = '';

/**
 * A room's auto-route switch, beside `!auto-route` and writing the same
 * setting: on, untagged messages are routed by the workspace's decision
 * service. Where the workspace has no decision backend, or the server has the
 * feature off, it is shown unavailable with the server's own reason, and can
 * only be turned off. Below it, the room's optional triage agent, which gets
 * undecided messages while the decision service is failing.
 *
 * Shows what the server says: the switch and picker move only once the
 * server has answered, and a refusal leaves them as they were with the
 * reason beside them. Only the room's owner and the workspace's admins may
 * change it, so for anyone else both are shown but held.
 */
export function RoomAutoRouteSection({
  workspaceId,
  room,
  autoRoute,
  agents,
  canManage,
  detailKey,
}: {
  workspaceId: string;
  room: Pick<RemoteRoomDetail, 'id'>;
  autoRoute: RoomAutoRoute;
  /** The room's agents, for the triage picker. */
  agents: { id: string; name: string }[];
  /** Whether the signed-in account may change it: the room's owner or a workspace admin. */
  canManage: boolean;
  /** The query the room's detail is read under, written back from each answer. */
  detailKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<'on' | 'fallback' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(
    which: 'on' | 'fallback',
    changes: { on?: boolean; fallbackAgent?: string | null }
  ) {
    setPending(which);
    setError(null);
    try {
      const updated = await rpc.workspaces.setRoomAutoRoute({
        workspaceId,
        roomId: room.id,
        ...changes,
      });
      queryClient.setQueryData<RemoteRoomDetail>(detailKey, (current) =>
        current ? { ...current, autoRoute: updated } : current
      );
    } catch (cause) {
      setError(failureText(cause, 'Could not change auto-route for this room.'));
    } finally {
      setPending(null);
    }
  }

  // Unavailable, it can still be turned off, so a room isn't stuck "on".
  const canFlip = canManage && pending === null && (autoRoute.available || autoRoute.on);
  const triage = autoRoute.fallbackAgent;
  // A triage agent that has left the room is still listed, so the setting stays visible.
  const triageChoices =
    triage !== null && !agents.some((agent) => agent.id === triage)
      ? [...agents, { id: triage, name: autoRoute.fallbackAgentName ?? triage }]
      : agents;
  const triageName =
    triage === null
      ? 'None'
      : (autoRoute.fallbackAgentName ??
        triageChoices.find((agent) => agent.id === triage)?.name ??
        triage);

  return (
    <section className="flex flex-col gap-3" aria-label="Auto-route">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-foreground">Auto-route</h2>
          <p className="text-xs text-foreground-muted">
            A message that tags nobody goes to the agent the workspace’s decision service picks. The
            same as <code>!auto-route on</code> in the room.
          </p>
        </div>
        <Switch
          aria-label="Auto-route in this room"
          checked={autoRoute.on}
          disabled={!canFlip}
          onCheckedChange={(on) => void change('on', { on })}
        />
      </div>

      {!autoRoute.available && (
        <p className="text-xs text-foreground-warning" role="note">
          {autoRoute.on ? 'On, but unavailable: ' : 'Unavailable: '}
          {autoRoute.reason ?? 'the server did not say why.'}
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-foreground-muted">
            Triage agent while auto-route is unavailable
          </span>
          <span className="text-xs text-foreground-muted">
            Gets the messages auto-route can’t decide while the decision service is failing.
            Otherwise they go to nobody.
          </span>
        </div>
        <Select
          value={autoRoute.fallbackAgent ?? NO_TRIAGE}
          disabled={!canManage || pending !== null}
          onValueChange={(next) =>
            void change('fallback', {
              fallbackAgent: next === NO_TRIAGE || next === null ? null : next,
            })
          }
        >
          <SelectTrigger aria-label="Triage agent" className="w-48 shrink-0">
            <SelectValue>{triageName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TRIAGE}>None</SelectItem>
            {triageChoices.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!canManage && (
        <p className="text-xs text-foreground-muted">
          Only the room’s owner or a workspace admin can change these.
        </p>
      )}
      {pending !== null && <span className="text-xs text-foreground-muted">Saving…</span>}
      {error !== null && <p className="text-xs text-destructive">Not changed — {error}</p>}
    </section>
  );
}
