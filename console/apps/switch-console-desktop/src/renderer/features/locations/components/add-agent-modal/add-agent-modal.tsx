import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { NewAgentForm } from './new-agent-form';

export type AddLocationModalProps = BaseModalProps<void> & {
  /**
   * Which control opened this dialog. Required rather than defaulted: four
   * places open it, and a default would silently file whichever one forgot
   * under the same heading as the ones that did not.
   */
  entryPoint: UiEntryPoint;
};

export function AddAgentModal({ onClose, entryPoint }: AddLocationModalProps) {
  return (
    <NewAgentForm
      onClose={onClose}
      onBack={null}
      entryPoint={entryPoint}
      serverId={null}
      initialRunLocation="local"
    />
  );
}
