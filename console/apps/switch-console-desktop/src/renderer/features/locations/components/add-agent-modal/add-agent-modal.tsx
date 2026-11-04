import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { NewAgentForm } from './new-agent-form';
import { machineRunLocation } from './server-run-locations';

export type AddLocationModalProps = BaseModalProps<void> & {
  /**
   * Which control opened this dialog. Required rather than defaulted: four
   * places open it, and a default would silently file whichever one forgot
   * under the same heading as the ones that did not.
   */
  entryPoint: UiEntryPoint;
  /**
   * The machine the agent goes on, picked already, with the server it is on
   * (which need not be the active one): null to start on this computer.
   */
  machine: { serverId: string; machineId: string } | null;
};

export function AddAgentModal({ onClose, entryPoint, machine }: AddLocationModalProps) {
  return (
    <NewAgentForm
      onClose={onClose}
      onBack={null}
      entryPoint={entryPoint}
      serverId={machine?.serverId ?? null}
      initialRunLocation={machine ? machineRunLocation(machine.machineId) : 'local'}
    />
  );
}
