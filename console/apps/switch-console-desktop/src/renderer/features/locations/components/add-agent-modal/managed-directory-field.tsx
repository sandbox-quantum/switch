import { ManagedDirectoryField as SharedManagedDirectoryField } from '@switch-console/chat-ui/components/new-agent-form';
import { useQuery } from '@tanstack/react-query';
import { machineWorkspaceFor } from '@renderer/features/managed-agents/managed-agent-state';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { LocalDirectorySelector } from './local-directory-selector';

/**
 * Where a new managed agent will run when no other directory is chosen: the
 * machine's workspaces folder and the agent's name, as the machine reports it.
 * For this computer, before its controller reports one, the folder Console
 * knows it keeps them in. Null while neither is known.
 */
export function useSuggestedManagedDirectory(
  serverId: string | null,
  machine: OwnedMachine | null,
  agentName: string
): { path: string | null; error: unknown } {
  const reported = machine ? machineWorkspaceFor(machine, agentName) : null;
  const name = agentName.trim();
  const askThisComputer =
    serverId !== null &&
    machine?.local?.kind === 'this-computer' &&
    machine.workspacesDir === null &&
    name !== '';
  const fallback = useQuery({
    queryKey: ['managed-default-workspace', serverId, name],
    queryFn: () => rpc.embeddedController.defaultWorkspace({ serverId: serverId!, name }),
    enabled: askThisComputer,
  });
  if (reported !== null) return { path: reported, error: null };
  if (!askThisComputer) return { path: null, error: null };
  return { path: fallback.data ?? null, error: fallback.error };
}

/**
 * Where a managed agent runs on its machine, as a settings row. On this
 * computer the folder is picked with the system dialog; on another machine it
 * is a path typed for that machine.
 */
export function ManagedDirectoryField({
  machine,
  machineLabel,
  value,
  suggested,
  onChange,
}: {
  machine: OwnedMachine;
  machineLabel: string;
  value: string;
  /** What the agent runs in while the field is empty; see {@link useSuggestedManagedDirectory}. */
  suggested: { path: string | null; error: unknown };
  onChange: (value: string) => void;
}) {
  return (
    <SharedManagedDirectoryField
      machineWord="machine"
      machineLabel={machineLabel}
      value={value}
      suggestedPath={suggested.path}
      error={
        suggested.error !== null
          ? failureText(suggested.error, 'The default folder could not be worked out.')
          : null
      }
      picker={
        machine.local?.kind === 'this-computer'
          ? (placeholder) => (
              <LocalDirectorySelector
                title="Choose the agent's working directory"
                message="The agent runs its sessions here."
                path={value}
                onPathChange={onChange}
                placeholder={placeholder}
              />
            )
          : null
      }
      onChange={onChange}
    />
  );
}
