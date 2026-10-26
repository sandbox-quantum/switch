import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  GiveMachineLogin,
  loginKindsFor,
} from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import {
  ProviderStatusRow,
  ReportedProviderLine,
} from '@renderer/lib/components/provider-status-row';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import type {
  MachineDetail,
  MachineProviderDetail,
} from '@shared/core/managed-agents/managed-agents';
import {
  isValidProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { CollapsibleSection } from './collapsible-section';

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

  // Folded at first: a provider that cannot run agents is already raised in a
  // notice above the details, so the list is reference.
  return (
    <CollapsibleSection title="Providers" defaultOpen={false}>
      {machine.providers.length === 0 ? (
        <p className="py-[9px] text-[13px] text-[var(--fg-dim)]">Not reported yet.</p>
      ) : (
        <div className="-mx-3 mt-1">
          {[...installed, ...missing].map((provider) => (
            <MachineProviderRow
              key={provider.provider}
              serverId={serverId}
              machine={machine}
              provider={provider}
            />
          ))}
        </div>
      )}
      {missing.length > 0 &&
        (thisComputer ? (
          <p className="mt-1 text-[13px] text-[var(--fg-dim)]">
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
          <p className="mt-1 text-[13px] text-[var(--fg-dim)]">
            Switch cannot install a provider on {machine.name}: install its CLI there, then recheck
            it here.
          </p>
        ))}
    </CollapsibleSection>
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
    <div>
      <ProviderStatusRow
        providerId={provider.provider}
        name={name}
        meta={provider.version ?? undefined}
        installed={installed}
        status={
          <span
            title={
              [
                provider.detail,
                provider.checkedAt
                  ? `Checked ${new Date(provider.checkedAt).toLocaleString()}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
          >
            <ReportedProviderLine reported={provider} checking={checking} />
            {!checking && provider.authSource && (
              <span className="text-xs text-foreground-muted">
                {' · '}
                {signInSource(provider.authSource, machine)}
              </span>
            )}
          </span>
        }
        actions={
          <>
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
          </>
        }
      />
      {failure && (
        <p role="alert" className="px-3 pb-2 text-xs text-foreground-error">
          {failure}
        </p>
      )}
      {giving && known !== null && (
        <div className="px-3 pb-3">
          <GiveMachineLogin
            serverId={serverId}
            machine={machine}
            provider={known}
            onClose={() => setGiving(false)}
          />
        </div>
      )}
    </div>
  );
}

/** Where a provider's sign-in on the machine comes from, in a few words. */
function signInSource(source: 'local' | 'sealed', machine: MachineDetail): string {
  if (source === 'sealed') return 'sent from Switch Console';
  return machine.local?.kind === 'this-computer'
    ? "this computer's sign-in"
    : 'signed in on the machine';
}
