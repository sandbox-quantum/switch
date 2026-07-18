import { CommandPaletteModal } from '@renderer/features/command-palette/command-palette-modal';
import { AddAgentModal } from '@renderer/features/locations/components/add-agent-modal/add-agent-modal';
import { CreateSessionModal } from '@renderer/features/sessions/create-session-modal/create-session-modal';
import { DeleteSessionModal } from '@renderer/features/sessions/delete-session-modal';
import { RenameSessionModal } from '@renderer/features/sessions/rename-session-modal';
import { AddServerModal } from '@renderer/features/switch-servers/AddServerModal';
import { AssignServerModal } from '@renderer/features/switch-servers/assign-server-modal';
import { ConfirmActionDialog } from '@renderer/lib/components/confirm-action-dialog';
import { ExternalLinkChoiceDialog } from '@renderer/lib/components/external-link-choice-dialog';
import { FeedbackModal } from '@renderer/lib/components/feedback-modal/feedback-modal';
import { UnsavedChangesDialog } from '@renderer/lib/components/unsaved-changes-dialog';
import { type ModalComponent } from '@renderer/lib/modal/modal-provider';

export type ModalSize = 'xs' | 'sm' | 'md' | 'lg';
export type ModalPosition = 'center' | 'top';

export type ModalRegistryEntry<TProps = unknown, TResult = unknown> = {
  component: ModalComponent<TProps, TResult>;
  size?: ModalSize;
  position?: ModalPosition;
};

export function createModal<TProps, TResult>(
  component: ModalComponent<TProps, TResult>,
  config: Omit<ModalRegistryEntry, 'component'> = {}
): ModalRegistryEntry<TProps, TResult> {
  return { component, ...config };
}

export const modalRegistry = {
  commandPaletteModal: createModal(CommandPaletteModal, { size: 'md' }),
  sessionModal: createModal(CreateSessionModal),
  addAgentModal: createModal(AddAgentModal),
  confirmActionModal: createModal(ConfirmActionDialog, { size: 'xs' }),
  confirmExternalLinkModal: createModal(ExternalLinkChoiceDialog, { size: 'sm' }),
  unsavedChangesModal: createModal(UnsavedChangesDialog, { size: 'xs' }),
  feedbackModal: createModal(FeedbackModal),
  renameSessionModal: createModal(RenameSessionModal, { size: 'xs' }),
  deleteSessionModal: createModal(DeleteSessionModal, { size: 'sm' }),
  addServerModal: createModal(AddServerModal, { size: 'sm' }),
  assignServerModal: createModal(AssignServerModal, { size: 'sm' }),
  // oxlint-disable-next-line typescript/no-explicit-any
} satisfies Record<string, ModalRegistryEntry<any, any>>;
