import { GiveMachineLogin as GiveLogin } from '@switch-console/chat-ui/components/give-machine-login';
import { providerLoginKinds } from '@switch-console/chat-ui/model/provider-catalogue';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  type AgentProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';

/**
 * Gives a machine a provider login, on demand: sealed in Console to the
 * machine's own key, so the server only relays it, and taken up by the machine
 * at once. Says whether the provider signs in with it there.
 */
export function GiveMachineLogin({
  serverId,
  machine,
  provider,
  onClose,
}: {
  serverId: string;
  machine: OwnedMachine;
  provider: AgentProviderId;
  onClose: () => void;
}) {
  return (
    <GiveLogin
      machineName={machine.name}
      provider={provider}
      providerName={providerDisplayName(provider) ?? provider}
      kinds={providerLoginKinds(provider, true)}
      thisComputer
      queryKey={[MANAGED_AGENTS_KEY, serverId]}
      give={async (login) =>
        (
          await rpc.managedAgents.giveMachineLogin({
            serverId,
            machineId: machine.id,
            provider,
            login,
          })
        ).operationId
      }
      outcome={(operationId) =>
        rpc.managedAgents.machineLoginOutcome({ serverId, machineId: machine.id, operationId })
      }
      failureText={failureText}
      onClose={onClose}
    />
  );
}
