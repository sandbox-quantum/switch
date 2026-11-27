import {
  type MachineProviderRow,
  MachineProvidersTable,
} from '@switch-console/chat-ui/components/machine-providers';
import { providerLoginKinds } from '@switch-console/chat-ui/model/provider-catalogue';
import type { Tone } from '@switch-console/chat-ui/primitives/tone-pill';
import { GiveMachineLogin } from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { agoLabel } from '@renderer/features/switch-servers/server-times';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { reportedHeadline } from '@renderer/lib/components/reported-provider';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import type {
  MachineDetail,
  MachineProviderDetail,
} from '@shared/core/managed-agents/managed-agents';
import {
  type AgentProviderId,
  isValidProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { Card } from './detail-card';

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
  const missing = machine.providers.some((p) => p.problem === 'not installed');
  const thisComputer = machine.local?.kind === 'this-computer';
  const now = new Date();

  return (
    <Card title="AI providers">
      <MachineProvidersTable
        machineName={machine.name}
        rows={machine.providers.map((provider) => providerRow(provider, machine, now))}
        host={{
          queryKey: [MANAGED_AGENTS_KEY, serverId],
          recheck: async (provider) =>
            (
              await rpc.managedAgents.recheckMachineProvider({
                serverId,
                machineId: machine.id,
                provider: provider as AgentProviderId,
              })
            ).operationId,
          recheckOutcome: (operationId) =>
            rpc.managedAgents.machineRecheckOutcome({
              serverId,
              machineId: machine.id,
              operationId,
            }),
          giveLogin: (provider, onClose) => (
            <GiveMachineLogin
              serverId={serverId}
              machine={machine}
              provider={provider as AgentProviderId}
              onClose={onClose}
            />
          ),
          failureText,
        }}
      />
      {missing &&
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

/** A provider's row: Give login and Recheck only for a provider Console knows, on a machine online. */
function providerRow(
  provider: MachineProviderDetail,
  machine: MachineDetail,
  now: Date
): MachineProviderRow {
  const known = isValidProviderId(provider.provider) ? provider.provider : null;
  const installed = provider.problem !== 'not installed';
  const online = machine.state === 'online';
  return {
    provider: provider.provider,
    name: providerDisplayName(provider.provider) ?? provider.provider,
    icon: <AgentIcon id={provider.provider} size={14} />,
    installed,
    version: provider.version,
    signIn: {
      tone: signInTone(provider),
      label: reportedHeadline(provider),
      detail: provider.detail,
    },
    source:
      installed && provider.ready && provider.authSource
        ? signInSource(provider.authSource, machine)
        : null,
    checked: provider.checkedAt
      ? {
          label: agoLabel(provider.checkedAt, now),
          title: new Date(provider.checkedAt).toLocaleString(),
        }
      : null,
    canGive:
      known !== null &&
      installed &&
      !provider.ready &&
      online &&
      machine.acceptsLogins &&
      providerLoginKinds(known, true).length > 0,
    canRecheck: known !== null && installed && online,
  };
}

/** The sign-in pill's tone: signed in, a check still to come, or signed out. */
function signInTone(provider: MachineProviderDetail): Tone {
  if (provider.ready) return 'ok';
  if (provider.problem === 'login not checked yet') return 'idle';
  return 'warning';
}

/** Where a provider's sign-in on the machine comes from, in a few words. */
function signInSource(source: 'local' | 'sealed', machine: MachineDetail): string {
  if (source === 'sealed') return 'Sent from Switch Console';
  return machine.local?.kind === 'this-computer' ? "This computer's sign-in" : 'On the device';
}
