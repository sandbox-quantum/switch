import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  GiveMachineLogin,
  loginKindsFor,
} from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { agoLabel } from '@renderer/features/switch-servers/server-times';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { reportedHeadline } from '@renderer/lib/components/reported-provider';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type {
  MachineDetail,
  MachineProviderDetail,
} from '@shared/core/managed-agents/managed-agents';
import {
  isValidProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { Card } from './detail-card';
import { TonePill } from './machine-marks';
import type { MachineTone } from './machine-state';

/** How often a recheck is asked about while the machine works on it. */
const RECHECK_POLL_MS = 1_500;

/**
 * The providers a machine reported, installed ones first, each in the row
 * Settings → Agent providers uses for this computer. What Switch can do from
 * here is ask the machine to check one again and give it a login; installing
 * a provider still happens on the machine, which the section says.
 */
export function MachineProviders({
  serverId,
  machine,
}: {
  serverId: string;
  machine: MachineDetail;
}) {
  const { navigate } = useNavigate();
  const installed = machine.providers.filter((p) => p.problem !== 'not installed');
  const missing = machine.providers.filter((p) => p.problem === 'not installed');
  const thisComputer = machine.local?.kind === 'this-computer';

  return (
    <Card title="AI providers">
      {machine.providers.length === 0 ? (
        <p className="text-[13px] text-[var(--fg-dim)]">Not reported yet.</p>
      ) : (
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
            {[...installed, ...missing].map((provider) => (
              <MachineProviderRow
                key={provider.provider}
                serverId={serverId}
                machine={machine}
                provider={provider}
              />
            ))}
          </tbody>
        </table>
      )}
      {missing.length > 0 &&
        (thisComputer ? (
          <p className="mt-2 text-[12px] text-[var(--fg-dim)]">
            Install providers on this computer from{' '}
            <button
              type="button"
              className="cursor-pointer text-foreground underline-offset-2 hover:underline"
              onClick={() => navigate('settings', { tab: 'clis-models' })}
            >
              Settings → Agent providers
            </button>
            .
          </p>
        ) : (
          <p className="mt-2 text-[12px] text-[var(--fg-dim)]">
            Switch cannot install a provider on {machine.name}: install its CLI there, then recheck
            it here.
          </p>
        ))}
    </Card>
  );
}

function MachineProviderRow({
  serverId,
  machine,
  provider,
}: {
  serverId: string;
  machine: MachineDetail;
  provider: MachineProviderDetail;
}) {
  const queryClient = useQueryClient();
  const [operationId, setOperationId] = useState<string | null>(null);
  const [giving, setGiving] = useState(false);
  const known = isValidProviderId(provider.provider) ? provider.provider : null;
  const name = providerDisplayName(provider.provider) ?? provider.provider;
  const installed = provider.problem !== 'not installed';
  const online = machine.state === 'online';

  const recheck = useMutation({
    mutationFn: (id: NonNullable<typeof known>) =>
      rpc.managedAgents.recheckMachineProvider({
        serverId,
        machineId: machine.id,
        provider: id,
      }),
    onSuccess: ({ operationId: id }) => setOperationId(id),
  });
  const outcome = useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'machine-recheck', operationId],
    queryFn: () =>
      rpc.managedAgents.machineRecheckOutcome({
        serverId,
        machineId: machine.id,
        operationId: operationId!,
      }),
    enabled: operationId !== null,
    refetchInterval: (query) =>
      query.state.data?.state === 'pending' || query.state.data === undefined
        ? RECHECK_POLL_MS
        : false,
  });
  const result = outcome.data;
  const done = result !== undefined && result.state !== 'pending';
  // What the machine found arrives with its report: read it now rather than at the next poll.
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
  }, [done, queryClient, serverId]);
  const checking = recheck.isPending || (operationId !== null && !done);

  const canGive =
    known !== null &&
    installed &&
    !provider.ready &&
    online &&
    machine.acceptsLogins &&
    loginKindsFor(known).length > 0;

  const failure = recheck.error
    ? failureText(recheck.error, `Could not ask ${machine.name} to check ${name}.`)
    : result?.state === 'failed'
      ? result.message
      : null;

  return (
    <>
      <tr className="border-t-[0.5px] border-[var(--hair-soft)]">
        <td className="py-1.5">
          <span className="flex items-center gap-2 truncate text-foreground">
            <AgentIcon id={provider.provider} size={14} />
            {name}
          </span>
        </td>
        <td
          className={cn('truncate py-1.5', installed ? 'text-foreground' : 'text-[var(--fg-dim)]')}
        >
          {installed
            ? `Installed${provider.version ? ` · v${provider.version}` : ''}`
            : 'Not installed'}
        </td>
        <td className="py-1.5" title={provider.detail ?? undefined}>
          {!installed ? (
            <span className="text-[var(--fg-dim)]">—</span>
          ) : checking ? (
            <span className="text-[var(--fg-dim)]">Checking…</span>
          ) : (
            <TonePill tone={signInTone(provider)} dot={false} label={reportedHeadline(provider)} />
          )}
        </td>
        <td className="truncate py-1.5 text-foreground">
          {installed && provider.ready && provider.authSource
            ? signInSource(provider.authSource, machine)
            : '—'}
        </td>
        <td
          className="truncate py-1.5 text-[var(--fg-dim)]"
          title={provider.checkedAt ? new Date(provider.checkedAt).toLocaleString() : undefined}
        >
          {provider.checkedAt ? agoLabel(provider.checkedAt, new Date()) : '—'}
        </td>
        <td className="py-1.5">
          <div className="flex items-center justify-end gap-1">
            {canGive && (
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
            {known !== null && installed && online && (
              <Button
                size="sm"
                variant="ghost"
                disabled={checking}
                onClick={() => recheck.mutate(known)}
                aria-label={`Recheck ${name} on ${machine.name}`}
              >
                <RefreshCw className={checking ? 'size-3.5 animate-spin' : 'size-3.5'} />
                Recheck
              </Button>
            )}
          </div>
        </td>
      </tr>
      {(failure || (giving && known !== null)) && (
        <tr>
          <td colSpan={6} className="pb-3">
            {failure && (
              <p role="alert" className="text-xs text-foreground-error">
                {failure}
              </p>
            )}
            {giving && known !== null && (
              <GiveMachineLogin
                serverId={serverId}
                machine={machine}
                provider={known}
                onClose={() => setGiving(false)}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** The sign-in pill's tone: signed in, a check still to come, or signed out. */
function signInTone(provider: MachineProviderDetail): MachineTone {
  if (provider.ready) return 'ok';
  if (provider.problem === 'login not checked yet') return 'idle';
  return 'warning';
}

/** Where a provider's sign-in on the machine comes from, in a few words. */
function signInSource(source: 'local' | 'sealed', machine: MachineDetail): string {
  if (source === 'sealed') return 'Sent from Switch Console';
  return machine.local?.kind === 'this-computer' ? "This computer's sign-in" : 'On the device';
}
