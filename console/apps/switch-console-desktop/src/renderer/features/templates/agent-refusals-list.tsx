import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentRefusal } from '@main/core/switch-servers/gateway-client';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/utils/utils';
import { refusalOperationLabel, refusalSummary, splitRefusals } from './agent-refusals';
import { formatTimeAgo } from './template-runs';

/**
 * The requests the server refused this user's agents, loaded when the
 * listing opens and again when the window regains focus.
 *
 * Quiet on failure: an older server without refusals answers 404 and the
 * list stays empty, and a failed refresh keeps what was already shown.
 */
function useAgentRefusals(serverId: string): AgentRefusal[] {
  const [refusals, setRefusals] = useState<AgentRefusal[]>([]);

  useEffect(() => {
    // An answer that lands after the listing moved to another server belongs
    // to the old one and is dropped.
    let current = true;
    const load = async () => {
      try {
        const list = await rpc.switchServers.listAgentRefusals({ serverId });
        if (current) setRefusals(list ?? []);
      } catch {
        // The refusals are a side note to the listing; it renders without them.
      }
    };
    setRefusals([]);
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [serverId]);

  return refusals;
}

function RefusalItem({ refusal }: { refusal: AgentRefusal }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5">
      <span className="flex items-baseline justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0">{refusal.agentName ?? 'A deleted agent'}</span>
          <span className="shrink-0 text-xs text-foreground-muted">
            {refusalOperationLabel(refusal.operation)}
          </span>
          {refusal.subject && (
            <span className="truncate text-xs text-foreground-passive">{refusal.subject}</span>
          )}
        </span>
        <span className="shrink-0 text-xs text-foreground-passive">
          {formatTimeAgo(Date.parse(refusal.createdAt))}
        </span>
      </span>
      <p className="text-xs break-words text-foreground-muted">{refusal.message}</p>
    </li>
  );
}

/**
 * A quiet line under "Recently used" that says how many requests the server
 * refused this user's agents in the last week. It only shows when there is
 * at least one; opening it lists them with the sentence each agent got, and
 * older ones sit behind a "Show older" link.
 */
export function AgentRefusalsRow({ serverId }: { serverId: string }) {
  const refusals = useAgentRefusals(serverId);
  const [open, setOpen] = useState(false);
  const [showOlder, setShowOlder] = useState(false);

  const { recent, older } = splitRefusals(refusals);
  if (recent.length === 0) return null;

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground-muted transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        {refusalSummary(recent.length)}
      </button>
      {open && (
        <div className="mt-1 pl-5">
          <ul className="flex flex-col divide-y divide-border">
            {recent.map((r) => (
              <RefusalItem key={r.id} refusal={r} />
            ))}
            {showOlder && older.map((r) => <RefusalItem key={r.id} refusal={r} />)}
          </ul>
          {older.length > 0 && !showOlder && (
            <button
              type="button"
              onClick={() => setShowOlder(true)}
              className="mt-1 cursor-pointer text-xs text-foreground-passive hover:text-foreground hover:underline"
            >
              Show older ({older.length})
            </button>
          )}
        </div>
      )}
    </section>
  );
}
