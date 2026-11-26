import { Cloud, Laptop, Monitor, Server } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { createElement, useRef, useState } from 'react';
import { managedAgentLabel } from '@renderer/features/managed-agents/managed-agent-state';
import {
  MANAGED_AGENTS_KEY,
  useOwnedMachines,
} from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import {
  MoveAgentModal as SharedMoveAgentModal,
  type MoveAgentMachine,
} from '@switch-console/chat-ui/components/move-agent-modal';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { machineKindLabel, moveTarget, namesakeLabel } from './machine-state';
import { useHotkey } from '@tanstack/react-hotkeys';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';

type Props = BaseModalProps<void> & { agent: ManagedAgentView };

/**
 * Moves a managed agent to another of its owner's machines. Each machine says
 * whether it can take the agent, by the rules Switch places it by; the ones
 * that cannot are listed but not picked. Its files stay where they are.
 */
export function MoveAgentModal({ agent, onSuccess, onClose }: Props) {
  const machinesQuery = useOwnedMachines(agent.serverId);
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = managedAgentLabel(agent);
  const provider = agent.definition.provider;
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const confirmHotkey = getEffectiveHotkey('confirm');

  useHotkey(getHotkeyRegistration('confirm'), () => confirmButtonRef.current?.click(), {
    enabled: !moving && confirmHotkey !== null,
  });

  const adaptedMachines: MoveAgentMachine[] | null = machinesQuery.data
    ? machinesQuery.data
        .filter((machine) => machine.id !== agent.machine?.id && machine.state !== 'revoked')
        .map((machine) => {
          const target = moveTarget(machine, provider);
          const Icon =
            machine.local?.kind === 'this-computer'
              ? Laptop
              : machine.cloud
                ? Cloud
                : machine.kind === 'console'
                  ? Monitor
                  : Server;
          return {
            id: machine.id,
            name: machine.name,
            kind: machine.kind,
            kindLabel: machineKindLabel(machine),
            icon: createElement(Icon, { className: 'size-4 text-foreground-muted' }),
            state: machine.state,
            thisComputer: machine.local?.kind === 'this-computer',
            selectable: target.selectable,
            selectabilityTone: target.tone,
            selectabilityLine: target.line,
            namesake: namesakeLabel(machine, machinesQuery.data ?? [], new Date()),
          };
        })
        .sort(
          (a, b) =>
            Number(b.selectable) - Number(a.selectable) ||
            Number(b.thisComputer) - Number(a.thisComputer) ||
            a.name.localeCompare(b.name)
        )
    : null;

  const folder = agent.status?.directory ?? agent.definition.directory;

  const handleMove = async (machineId: string) => {
    setMoving(true);
    setError(null);
    try {
      await rpc.managedAgents.update({
        serverId: agent.serverId,
        agentId: agent.agentId,
        changes: { definition: {}, machineId },
      });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, agent.serverId] });
      onSuccess();
    } catch (err) {
      setError(failureText(err, `Could not move ${label}.`));
      setMoving(false);
    }
  };

  return (
    <SharedMoveAgentModal
      agentName={label}
      currentMachineName={agent.machine?.name ?? null}
      workingDirectory={folder}
      machines={adaptedMachines}
      machinesError={machinesQuery.error ? failureText(machinesQuery.error, 'Could not read your machines.') : null}
      moving={moving}
      moveError={error}
      onMove={handleMove}
      onClose={onClose}
      confirmLabel={`Move ${label}`}
      confirmButtonRef={confirmButtonRef}
    />
  );
}
