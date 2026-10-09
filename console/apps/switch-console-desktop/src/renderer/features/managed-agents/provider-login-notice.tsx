import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { GiveMachineLogin } from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import { Button } from '@renderer/lib/ui/button';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import { providerLoginProblem } from './managed-agent-state';

/**
 * Says when the agent's provider cannot sign in on its machine, which is what a
 * machine enrolled again comes back as, and gives the machine that login on the
 * spot. Nothing when the provider signs in there.
 */
export function ProviderLoginNotice({
  agent,
  machine,
}: {
  agent: ManagedAgentView;
  machine: OwnedMachine | null;
}) {
  const [giving, setGiving] = useState(false);
  const login = providerLoginProblem(agent, machine);
  if (!login || !machine) return null;
  const provider = login.provider;
  if (giving && isValidProviderId(provider))
    return (
      <GiveMachineLogin
        serverId={agent.serverId}
        machine={machine}
        provider={provider}
        onClose={() => setGiving(false)}
      />
    );
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg bg-background-error px-3 py-2 text-sm text-foreground-error"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">
        {login.name} is {login.problem} on {machine.name}, so this agent cannot answer.
        {login.problem === 'not installed'
          ? ''
          : ' A machine enrolled again needs its logins given again.'}
      </span>
      {login.problem !== 'not installed' && isValidProviderId(provider) && (
        <Button size="sm" variant="outline" onClick={() => setGiving(true)}>
          Give login
        </Button>
      )}
    </div>
  );
}
