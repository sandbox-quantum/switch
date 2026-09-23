import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { NewAgentForm } from './new-agent-form';

export type AddLocationModalProps = BaseModalProps<void> & {
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
