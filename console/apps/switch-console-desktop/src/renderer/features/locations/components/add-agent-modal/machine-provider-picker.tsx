import { MachineProviderPicker as SharedMachineProviderPicker } from '@switch-console/chat-ui/components/new-agent-form';
import {
  type MachineProviderOption,
  machineProviderOptions as optionsOnMachine,
  providerLoginKinds,
} from '@switch-console/chat-ui/model/provider-catalogue';
import { useCallback, useMemo } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import type { FeatureFlags } from '@shared/core/feature-flags/feature-flags';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  offeredAgentProviders,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import { autoSelectedAgentType } from './agent-type-auto-selection';
import { GiveMachineLogin } from './give-machine-login';

/**
 * Each provider the server offers (its `flags`), and whether the machine last
 * reported it installed and logged in.
 */
export function machineProviderOptions(
  machine: OwnedMachine,
  flags: FeatureFlags
): MachineProviderOption<AgentProviderId>[] {
  return optionsOnMachine(offeredAgentProviders(flags), machine.providers);
}

/**
 * The agent provider for a managed agent, from what its machine reports to the
 * server: only the providers installed and logged in there can be picked.
 */
export function MachineProviderPicker({
  serverId,
  machine,
  value,
  onChange,
  defaultAgent,
}: {
  serverId: string;
  machine: OwnedMachine;
  value: AgentProviderId | null;
  onChange: (providerId: AgentProviderId) => void;
  /** The user's default agent; undefined while it loads. */
  defaultAgent: string | undefined;
}) {
  const flags = useFeatureFlags(serverId);
  const options = useMemo(() => machineProviderOptions(machine, flags), [machine, flags]);
  const autoSelect = useCallback(
    (ready: AgentProviderId[]) => autoSelectedAgentType(ready, defaultAgent),
    [defaultAgent]
  );

  return (
    <SharedMachineProviderPicker
      machineName={machine.name}
      reportedTo="the server"
      reported={machine.providers.length > 0}
      options={options}
      value={value}
      onChange={onChange}
      autoSelect={autoSelect}
      icon={(id) => <AgentIcon id={id} size={22} />}
      acceptsLogins={machine.acceptsLogins}
      loginOffered={(id) => providerLoginKinds(id, true).length > 0}
      loginInCard={false}
      giveLogin={(provider, onClose) => (
        <GiveMachineLogin
          serverId={serverId}
          machine={machine}
          provider={provider}
          onClose={onClose}
        />
      )}
    />
  );
}
