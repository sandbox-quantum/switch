import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../model/cn';
import { Button } from '../primitives/button';
import { type Tone, TonePill } from '../primitives/tone-pill';
import type { OperationOutcome } from './give-machine-login';

/** How often a recheck is asked about while the machine works on it. */
const RECHECK_POLL_MS = 1_500;

/** One provider a machine reported, worded by the app. */
export type MachineProviderRow = {
  provider: string;
  name: string;
  icon: ReactNode;
  installed: boolean;
  version: string | null;
  /** Its sign-in, as a pill, with what the machine said more about it for its hover title. */
  signIn: { tone: Tone; label: string; detail: string | null };
  /** Where its sign-in comes from, in a few words; null when it has none. */
  source: string | null;
  checked: { label: string; title: string } | null;
  canGive: boolean;
  canRecheck: boolean;
};

/**
 * What the table asks of the app: to recheck a provider and say how that went,
 * the Give login form for a provider, and how to word a failure. The app keeps
 * its machines under `queryKey`, read again when a recheck finishes.
 */
export type MachineProvidersHost = {
  queryKey: readonly unknown[];
  /** Asks the machine to check the provider again; answers the operation. */
  recheck: (provider: string) => Promise<string>;
  recheckOutcome: (operationId: string) => Promise<OperationOutcome>;
  giveLogin: (provider: string, onClose: () => void) => ReactNode;
  failureText: (error: unknown, fallback: string) => string;
};

/**
 * The providers a machine reported, installed ones first, each with what can
 * be done about it from here: give the machine a login, and have it check the
 * provider again.
 */
export function MachineProvidersTable({
  machineName,
  rows,
  host,
}: {
  machineName: string;
  rows: MachineProviderRow[];
  host: MachineProvidersHost;
}) {
  if (rows.length === 0)
    return <p className="text-[13px] text-[var(--fg-dim)]">Not reported yet.</p>;
  return (
    <table className="w-full table-fixed text-[13px]">
      <thead>
        <tr className="text-left text-[12px] text-[var(--fg-dim)]">
          <th className="w-[18%] pb-2 font-normal">Provider</th>
          <th className="w-[17%] pb-2 font-normal">Installed</th>
          <th className="w-[15%] pb-2 font-normal">Sign-in</th>
          <th className="pb-2 font-normal">Where the sign-in comes from</th>
          <th className="w-[13%] pb-2 font-normal">Last checked</th>
          <th className="w-[150px] pb-2" />
        </tr>
      </thead>
      <tbody>
        {[...rows.filter((row) => row.installed), ...rows.filter((row) => !row.installed)].map(
          (row) => (
            <ProviderRow key={row.provider} machineName={machineName} row={row} host={host} />
          )
        )}
      </tbody>
    </table>
  );
}

function ProviderRow({
  machineName,
  row,
  host,
}: {
  machineName: string;
  row: MachineProviderRow;
  host: MachineProvidersHost;
}) {
  const queryClient = useQueryClient();
  const [operationId, setOperationId] = useState<string | null>(null);
  const [giving, setGiving] = useState(false);
  const announced = useRef<string | null>(null);
  const { name, installed } = row;

  const recheck = useMutation({
    mutationFn: () => host.recheck(row.provider),
    onSuccess: (id) => setOperationId(id),
  });
  const outcome = useQuery({
    queryKey: [...host.queryKey, 'machine-recheck', operationId],
    queryFn: () => host.recheckOutcome(operationId!),
    enabled: operationId !== null,
    retry: false,
    // A read that failed ends the wait: its error is shown, and Recheck asks again.
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      (query.state.data?.state === 'pending' || query.state.data === undefined)
        ? RECHECK_POLL_MS
        : false,
  });
  const result = outcome.data;
  const done = outcome.isError || (result !== undefined && result.state !== 'pending');
  // What the machine found arrives with its report: read it now rather than at the next poll.
  useEffect(() => {
    if (!done || announced.current === operationId) return;
    announced.current = operationId;
    void queryClient.invalidateQueries({ queryKey: host.queryKey });
  }, [done, operationId, queryClient, host.queryKey]);
  const checking = recheck.isPending || (operationId !== null && !done);

  const failure = recheck.error
    ? host.failureText(recheck.error, `Could not ask ${machineName} to check ${name}.`)
    : outcome.error
      ? host.failureText(outcome.error, `Could not find out how ${machineName} checked ${name}.`)
      : result?.state === 'failed'
        ? result.message
        : null;

  return (
    <>
      <tr className="border-t-[0.5px] border-[var(--hair-soft)]">
        <td className="py-1.5">
          <span className="flex items-center gap-2 truncate text-foreground">
            {row.icon}
            {name}
          </span>
        </td>
        <td
          className={cn('truncate py-1.5', installed ? 'text-foreground' : 'text-[var(--fg-dim)]')}
        >
          {installed ? `Installed${row.version ? ` · v${row.version}` : ''}` : 'Not installed'}
        </td>
        <td className="py-1.5" title={row.signIn.detail ?? undefined}>
          {!installed ? (
            <span className="text-[var(--fg-dim)]">—</span>
          ) : checking ? (
            <span className="text-[var(--fg-dim)]">Checking…</span>
          ) : (
            <TonePill tone={row.signIn.tone} dot={false} label={row.signIn.label} />
          )}
        </td>
        <td className="truncate py-1.5 text-foreground">{row.source ?? '—'}</td>
        <td className="truncate py-1.5 text-[var(--fg-dim)]" title={row.checked?.title}>
          {row.checked?.label ?? '—'}
        </td>
        <td className="py-1.5">
          <div className="flex items-center justify-end gap-1">
            {row.canGive && (
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={giving}
                onClick={() => setGiving((open) => !open)}
              >
                <KeyRound className="size-3.5" />
                Give login
              </Button>
            )}
            {row.canRecheck && (
              <Button
                size="sm"
                variant="ghost"
                disabled={checking}
                onClick={() => recheck.mutate()}
                aria-label={`Recheck ${name} on ${machineName}`}
              >
                <RefreshCw className={checking ? 'size-3.5 animate-spin' : 'size-3.5'} />
                Recheck
              </Button>
            )}
          </div>
        </td>
      </tr>
      {(failure || giving) && (
        <tr>
          <td colSpan={6} className="pb-3">
            {failure && (
              <p role="alert" className="text-xs text-foreground-error">
                {failure}
              </p>
            )}
            {giving && host.giveLogin(row.provider, () => setGiving(false))}
          </td>
        </tr>
      )}
    </>
  );
}
